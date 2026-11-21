import { z } from 'zod';
import type { PlayerId } from './moves.js';
import { teamOfSeat, type TeamIndex } from './teams.js';

/**
 * Tournaments v1: a series of N normal games in one room (CLAUDE.md "Tournaments").
 * Pure scoring and standings, shared by the server (which stores results) and the web (types).
 * The engine knows nothing about tournaments.
 */
export const TOURNAMENT_GAME_COUNTS = [3, 5, 7] as const;
export type TournamentGameCount = (typeof TOURNAMENT_GAME_COUNTS)[number];
export const TournamentGameCountSchema = z.union([z.literal(3), z.literal(5), z.literal(7)]);

/** A series needs at least this many humans who haven't left; below it, it ends early. */
export const TOURNAMENT_MIN_HUMANS = 2;
/** Between games, if the host has been offline this long, any connected human may lead. */
export const TOURNAMENT_HOST_AWAY_MS = 60_000;

export const TOURNAMENT_STATUSES = ['running', 'finished', 'endedEarly'] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

/**
 * Who scores: a seat (`playerId`) in a classic series, a team (`team0` / `team1`) in a 2v2 series.
 */
export type EntrantKey = string;
export function teamKey(team: TeamIndex): EntrantKey {
  return `team${team}`;
}

/** One seat of the locked roster (public). */
export interface TournamentSeat {
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly isBot: boolean;
  /** The human who held this seat left the series: a bot plays it, it can never be champion. */
  readonly left: boolean;
}

/** One counted game. Points are multiples of 0.5. */
export interface TournamentGameResult {
  readonly gameId: string;
  readonly points: Readonly<Record<EntrantKey, number>>;
  /** Entrants charged a durak this game: the durak's entrant and every forfeiter's. */
  readonly duraks: readonly EntrantKey[];
  /** Entrants that went out first (the first finish group; the winning team in 2v2). */
  readonly firsts: readonly EntrantKey[];
}

/** What a finished game contributes to the score (built by the server from the stored game). */
export interface GameScoringInput {
  readonly gameId: string;
  readonly teams: boolean;
  /** Seat order. */
  readonly playerIds: readonly PlayerId[];
  /** Who went out together, in order (each step of the game that put players out is one group). */
  readonly finishGroups: readonly (readonly PlayerId[])[];
  readonly durakId: PlayerId | null;
  readonly forfeits: readonly PlayerId[];
}

function entrantOf(teams: boolean, playerIds: readonly PlayerId[], id: PlayerId): EntrantKey {
  if (!teams) return id;
  const seat = playerIds.indexOf(id);
  return teamKey(teamOfSeat(seat < 0 ? 0 : seat));
}

/**
 * Classic: finishing order. Place i (0-based) is worth n−1−i; a group that went out together
 * shares the average of its places; the durak is last (0); a forfeiter scores 0 and their place's
 * points go to nobody. Seats in no group (defensive) share the places left before the durak.
 *
 * Teams: the durak's team 0, the other 1; a draw 0.5 each; a team with a forfeiter scores 0.
 */
export function scoreGame(input: GameScoringInput): TournamentGameResult {
  const { teams, playerIds, durakId, forfeits } = input;
  const forfeitSet = new Set(forfeits);
  const duraks = new Set<EntrantKey>();
  if (durakId !== null) duraks.add(entrantOf(teams, playerIds, durakId));
  for (const id of forfeits) if (playerIds.includes(id)) duraks.add(entrantOf(teams, playerIds, id));

  if (teams) {
    const keys = [teamKey(0), teamKey(1)];
    const losing = durakId === null ? null : entrantOf(true, playerIds, durakId);
    const points: Record<EntrantKey, number> = {};
    for (const key of keys) points[key] = losing === null ? 0.5 : key === losing ? 0 : 1;
    for (const id of forfeits) if (playerIds.includes(id)) points[entrantOf(true, playerIds, id)] = 0;
    const firsts = losing === null ? [] : keys.filter((k) => k !== losing && points[k]! > 0);
    return { gameId: input.gameId, points, duraks: keys.filter((k) => duraks.has(k)), firsts };
  }

  const n = playerIds.length;
  const placed = new Set<PlayerId>();
  const groups: PlayerId[][] = [];
  for (const group of input.finishGroups) {
    const g = group.filter((id) => playerIds.includes(id) && id !== durakId && !placed.has(id));
    for (const id of g) placed.add(id);
    if (g.length > 0) groups.push(g);
  }
  const rest = playerIds.filter((id) => id !== durakId && !placed.has(id));
  if (rest.length > 0) groups.push(rest);

  const points: Record<EntrantKey, number> = {};
  let place = 0;
  for (const group of groups) {
    let sum = 0;
    for (let i = 0; i < group.length; i++) sum += n - 1 - (place + i);
    const share = sum / group.length;
    for (const id of group) points[id] = forfeitSet.has(id) ? 0 : share;
    place += group.length;
  }
  if (durakId !== null && playerIds.includes(durakId)) points[durakId] = 0;
  for (const id of playerIds) if (forfeitSet.has(id)) points[id] = 0;

  const first = groups[0] ?? [];
  const firsts = first.filter((id) => !forfeitSet.has(id));
  return { gameId: input.gameId, points, duraks: playerIds.filter((id) => duraks.has(id)), firsts };
}

export interface StandingRow {
  readonly key: EntrantKey;
  /** The seats behind this entrant (one seat, or both partners). */
  readonly playerIds: readonly PlayerId[];
  readonly points: number;
  readonly duraks: number;
  readonly firsts: number;
  /** Points from the latest counted game, or null before the first. */
  readonly lastPoints: number | null;
  /** May be champion: a classic seat that wasn't left; a team with at least one seat not left. */
  readonly eligible: boolean;
  /** 1-based; equal scores share a rank (1, 1, 3). */
  readonly rank: number;
}

export interface StandingsInput {
  readonly teams: boolean;
  readonly roster: readonly TournamentSeat[];
  readonly results: readonly TournamentGameResult[];
}

/** Better first: more points, then fewer duraks, then more first-out finishes. 0 = tied. */
function compareRows(a: Omit<StandingRow, 'rank'>, b: Omit<StandingRow, 'rank'>): number {
  if (a.points !== b.points) return b.points - a.points;
  if (a.duraks !== b.duraks) return a.duraks - b.duraks;
  return b.firsts - a.firsts;
}

/** The standings, derived from the results only (best first; ties keep seat order). */
export function standings(input: StandingsInput): StandingRow[] {
  const { teams, roster, results } = input;
  const entrants: { key: EntrantKey; playerIds: PlayerId[] }[] = teams
    ? [0, 1].map((t) => ({
        key: teamKey(t as TeamIndex),
        playerIds: roster.filter((_, seat) => teamOfSeat(seat) === t).map((s) => s.playerId),
      }))
    : roster.map((s) => ({ key: s.playerId, playerIds: [s.playerId] }));
  const last = results[results.length - 1];
  const rows = entrants.map((e) => {
    const seats = roster.filter((s) => e.playerIds.includes(s.playerId));
    return {
      key: e.key,
      playerIds: e.playerIds,
      points: results.reduce((sum, r) => sum + (r.points[e.key] ?? 0), 0),
      duraks: results.filter((r) => r.duraks.includes(e.key)).length,
      firsts: results.filter((r) => r.firsts.includes(e.key)).length,
      lastPoints: last ? (last.points[e.key] ?? 0) : null,
      eligible: seats.some((s) => !s.left),
    };
  });
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareRows(a.row, b.row) || a.index - b.index)
    .map((x) => x.row);
  return sorted.map((row) => ({
    ...row,
    rank: 1 + sorted.filter((other) => compareRows(other, row) < 0).length,
  }));
}

/**
 * The champions of a finished series: every eligible entrant tied with the best eligible one
 * (co-champions). A bot seat can be champion. Empty if nobody is eligible.
 */
export function championsOf(rows: readonly StandingRow[]): EntrantKey[] {
  const eligible = rows.filter((r) => r.eligible);
  const best = eligible[0];
  if (!best) return [];
  return eligible.filter((r) => compareRows(r, best) === 0).map((r) => r.key);
}

/** The public tournament, as every room member and spectator sees it in room:state. */
export interface TournamentView {
  readonly id: string;
  readonly status: TournamentStatus;
  readonly teams: boolean;
  readonly gamesPlanned: TournamentGameCount;
  readonly gamesPlayed: number;
  readonly roster: readonly TournamentSeat[];
  readonly standings: readonly StandingRow[];
  /** Entrant keys; empty while running, for an early end, or if nobody was eligible. */
  readonly champions: readonly EntrantKey[];
  /**
   * Between games (room finished, series running): the epoch ms from which any connected human may
   * start the next game or end the series because the host is away (0 = now; null = host only).
   * Compare with `serverTime` (clock-skew free).
   */
  readonly leadOpenAt: number | null;
  readonly serverTime: number;
}

/** The lobby's tournament setting (null = a single game). */
export interface TournamentSetup {
  readonly games: TournamentGameCount;
}
