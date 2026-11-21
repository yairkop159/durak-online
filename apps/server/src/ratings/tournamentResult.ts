import { DEFAULT_GAME_CONFIG, teamKey, teamOfSeat, type GameMode, type TournamentGameCount } from '@durak/shared';
import type { Room } from '../domain/types.js';
import { championSeats, creditedProfiles, tournamentStandings } from '../services/tournament.js';

/** One roster seat of a stored tournament. */
export interface TournamentResultSeat {
  readonly seat: number;
  readonly playerId: string;
  readonly profileId: string | null;
  readonly nickname: string;
  readonly isBot: boolean;
  readonly left: boolean;
  /** The seat's points (classic) or its team's (2v2). */
  readonly points: number;
  readonly duraks: number;
  readonly rank: number;
  readonly champion: boolean;
  /** Gets +1 `tournaments_won` (see `creditedProfiles`: never with a bot champion, never a left seat). */
  readonly credited: boolean;
}

/** What the match history stores for a series that is over (snapshot taken inside the room lock). */
export interface TournamentResultInput {
  readonly tournamentId: string;
  readonly roomId: string;
  readonly mode: GameMode;
  readonly teams: boolean;
  readonly gamesPlanned: TournamentGameCount;
  readonly gamesPlayed: number;
  readonly status: 'finished' | 'endedEarly';
  readonly startedAt: number;
  readonly endedAt: number;
  readonly seats: readonly TournamentResultSeat[];
}

/**
 * The stored result of the room's series, or null: still running, no series, or no profiled human
 * took part (nothing worth keeping, like games).
 */
export function buildTournamentInput(room: Room): TournamentResultInput | null {
  const t = room.tournament;
  if (!t || t.status === 'running') return null;
  if (!t.roster.some((s) => !s.isBot && s.profileId !== null)) return null;
  const rows = tournamentStandings(t);
  const champions = new Set(championSeats(t).map((s) => s.playerId));
  const credited = new Set(creditedProfiles(t));
  const seats = t.roster.map((s, seat): TournamentResultSeat => {
    const key = t.teams ? teamKey(teamOfSeat(seat)) : s.playerId;
    const row = rows.find((r) => r.key === key);
    return {
      seat,
      playerId: s.playerId,
      profileId: s.isBot ? null : s.profileId,
      nickname: s.nickname,
      isBot: s.isBot,
      left: s.left,
      points: row?.points ?? 0,
      duraks: row?.duraks ?? 0,
      rank: row?.rank ?? rows.length,
      champion: champions.has(s.playerId),
      credited: s.profileId !== null && credited.has(s.profileId),
    };
  });
  return {
    tournamentId: t.id,
    roomId: room.id,
    mode: room.config.mode ?? DEFAULT_GAME_CONFIG.mode,
    teams: t.teams,
    gamesPlanned: t.gamesPlanned,
    gamesPlayed: t.results.length,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? t.startedAt,
    seats,
  };
}
