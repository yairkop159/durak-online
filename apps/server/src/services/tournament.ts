import {
  championsOf,
  isTeamGame,
  scoreGame,
  standings,
  TOURNAMENT_HOST_AWAY_MS,
  TOURNAMENT_MIN_HUMANS,
  type EntrantKey,
  type GameScoringInput,
  type PlayerId,
  type StandingRow,
  type TournamentGameCount,
  type TournamentView,
} from '@durak/shared';
import type { Room, RoomMember, StoredGame, Tournament } from '../domain/types.js';
import { isActiveHuman, takeoverMember } from './departure.js';

/**
 * Tournaments v1 on the server (pure; CLAUDE.md "Tournaments"). The scoring itself is the shared
 * `scoreGame`; this file maps rooms and stored games onto it. Callers hold the room lock and save
 * the returned room in the same write as the change that caused it.
 */

export const tournamentRunning = (room: Room): boolean => room.tournament?.status === 'running';

/** A new series with the room's seats as the locked roster. */
export function newTournament(room: Room, games: TournamentGameCount, id: string, now: number): Tournament {
  return {
    id,
    status: 'running',
    teams: isTeamGame(room.config),
    gamesPlanned: games,
    startedAt: now,
    endedAt: null,
    roster: room.members.map((m) => ({
      playerId: m.playerId,
      nickname: m.nickname,
      isBot: m.isBot,
      left: false,
      profileId: m.isBot ? null : m.profileId,
    })),
    results: [],
  };
}

/** Humans of the roster who still hold their seat. */
export function activeHumans(t: Tournament): number {
  return t.roster.filter((s) => !s.isBot && !s.left).length;
}

/**
 * The finish groups of a stored game. Games stored before tournaments have none: their
 * `finishOrder` becomes one player per group. Players missing from the groups (defensive) follow
 * as singletons in finish order.
 */
export function finishGroupsOf(game: StoredGame): PlayerId[][] {
  const durak = game.state.phase.kind === 'finished' ? game.state.phase.durak : null;
  const groups = game.finishGroups.map((g) => [...g]);
  const seen = new Set(groups.flat());
  for (const id of game.state.finishOrder) if (id !== durak && !seen.has(id)) groups.push([id]);
  return groups;
}

export function scoringInput(game: StoredGame, teams: boolean): GameScoringInput {
  return {
    gameId: game.gameId,
    teams,
    playerIds: game.state.players.map((p) => p.id),
    finishGroups: finishGroupsOf(game),
    durakId: game.state.phase.kind === 'finished' ? game.state.phase.durak : null,
    forfeits: game.forfeits,
  };
}

/**
 * Marks roster seats whose human left (the seat is gone or `leftGame`). With fewer than
 * TOURNAMENT_MIN_HUMANS left, a running series ends early (standings frozen, no champion).
 */
export function reconcileRoster(t: Tournament, room: Room, now: number): Tournament {
  let changed = false;
  const roster = t.roster.map((seat) => {
    if (seat.isBot || seat.left) return seat;
    const member = room.members.find((m) => m.playerId === seat.playerId);
    if (member && !member.leftGame) return seat;
    changed = true;
    return { ...seat, left: true };
  });
  const next = changed ? { ...t, roster } : t;
  if (next.status === 'running' && activeHumans(next) < TOURNAMENT_MIN_HUMANS) {
    return { ...next, status: 'endedEarly', endedAt: now };
  }
  return next;
}

/**
 * Scores a finished game once (idempotent by gameId). Restarted and abandoned games count for
 * nothing: the same game number is played again. After the last planned game: `finished`.
 */
export function scoreFinishedGame(t: Tournament, game: StoredGame, now: number): Tournament {
  if (t.status !== 'running' || game.state.phase.kind !== 'finished') return t;
  if (game.endReason === 'restarted' || game.endReason === 'abandoned') return t;
  if (t.results.some((r) => r.gameId === game.gameId)) return t;
  const ids = game.state.players.map((p) => p.id);
  if (ids.length !== t.roster.length || !t.roster.every((s, i) => s.playerId === ids[i])) return t;
  const results = [...t.results, scoreGame(scoringInput(game, t.teams))];
  const done = results.length >= t.gamesPlanned;
  return { ...t, results, ...(done ? { status: 'finished' as const, endedAt: now } : {}) };
}

/**
 * The room's series after a change: departures first (a series that drops below two humans ends
 * early, and the game that caused it does not count), then the finished game's score.
 * Returns `room` itself when nothing changed.
 */
export function advanceTournament(room: Room, finishedGame: StoredGame | null, now: number): Room {
  const t = room.tournament;
  if (!t || t.status !== 'running') return room;
  const reconciled = reconcileRoster(t, room, now);
  const scored = finishedGame ? scoreFinishedGame(reconciled, finishedGame, now) : reconciled;
  return scored === t ? room : { ...room, tournament: scored };
}

export function endTournamentEarly(t: Tournament, now: number): Tournament {
  return t.status === 'running' ? { ...t, status: 'endedEarly', endedAt: now } : t;
}

export function tournamentStandings(t: Tournament): StandingRow[] {
  return standings({ teams: t.teams, roster: t.roster, results: t.results });
}

/** Champions of a finished series (co-champions share it); none while running or after an early end. */
export function tournamentChampions(t: Tournament): EntrantKey[] {
  return t.status === 'finished' ? championsOf(tournamentStandings(t)) : [];
}

/** The roster seats behind the champions. */
export function championSeats(t: Tournament): Tournament['roster'] {
  const keys = tournamentChampions(t);
  const rows = tournamentStandings(t).filter((r) => keys.includes(r.key));
  const ids = new Set(rows.flatMap((r) => r.playerIds));
  return t.roster.filter((s) => ids.has(s.playerId));
}

/**
 * Profiles credited with a tournament win: every profiled, non-left human champion seat — but
 * nobody at all if a bot seat is among the champions (a bot win, or a team with a bot partner,
 * is not a human tournament win). Empty for an early end.
 */
export function creditedProfiles(t: Tournament): string[] {
  const seats = championSeats(t);
  if (seats.some((s) => s.isBot)) return [];
  return seats.filter((s) => !s.left && s.profileId !== null).map((s) => s.profileId as string);
}

/**
 * Between games (room finished, series running), who may start the next game or end the series:
 * the host; or any connected active human once the host is not an active human any more, or has
 * been offline for TOURNAMENT_HOST_AWAY_MS. Null = nobody (no game to lead right now).
 * Returns the epoch ms from which non-hosts may lead (0 = already), or null = host only.
 */
export function leadOpenAt(room: Room): number | null {
  if (room.status !== 'finished' || !tournamentRunning(room)) return null;
  const host = room.members.find((m) => m.playerId === room.hostId);
  if (!host || !isActiveHuman(host)) return 0;
  if (host.connected) return null;
  // Offline since an unknown time (e.g. from before a server restart): treat as away now.
  return host.disconnectedAt === null ? 0 : host.disconnectedAt + TOURNAMENT_HOST_AWAY_MS;
}

export function canLeadTournament(room: Room, playerId: PlayerId, now: number): boolean {
  if (room.status !== 'finished' || !tournamentRunning(room)) return false;
  const member = room.members.find((m) => m.playerId === playerId);
  if (!member || !isActiveHuman(member)) return false;
  if (playerId === room.hostId) return true;
  const openAt = leadOpenAt(room);
  return member.connected && openAt !== null && now >= openAt;
}

/**
 * The seats for the next game of a series: the same roster in the same order. A seat whose human
 * left (and wasn't taken over yet) becomes a bot seat; AFK, timeout and grace state reset.
 */
export function nextGameMembers(members: readonly RoomMember[]): RoomMember[] {
  return members.map((m) => {
    const seat = m.leftGame && !m.isBot ? takeoverMember(m) : m;
    return { ...seat, afk: false, consecutiveTimeouts: 0, graceDeadline: null };
  });
}

/** The public view in room:state (no profile ids). */
export function tournamentView(room: Room, now: number): TournamentView | null {
  const t = room.tournament;
  if (!t) return null;
  return {
    id: t.id,
    status: t.status,
    teams: t.teams,
    gamesPlanned: t.gamesPlanned,
    gamesPlayed: t.results.length,
    roster: t.roster.map(({ playerId, nickname, isBot, left }) => ({ playerId, nickname, isBot, left })),
    standings: tournamentStandings(t),
    champions: tournamentChampions(t),
    leadOpenAt: leadOpenAt(room),
    serverTime: now,
  };
}
