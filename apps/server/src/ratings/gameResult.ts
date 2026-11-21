import { TEAM_GAME_PLAYERS, teamOfSeat, type GameEndReason, type GameMode, type PlayerResult } from '@durak/shared';
import { eloDeltas, teamEloDeltas, type EloPlayer, type TeamEloPlayer } from './elo.js';

/**
 * One seat of a finished game, as the match history stores it. A plain snapshot taken inside the
 * room lock when the game ends, so the write to Postgres can happen later (and be retried).
 */
export interface ResultSeat {
  /** Index in the game's seating order (`state.players`). */
  readonly seat: number;
  readonly playerId: string;
  readonly nickname: string;
  /** A bot seat from the start. A human whose seat a bot took over is not a bot. */
  readonly isBot: boolean;
  /** The profile this human sat down with, or null (bots, humans without a profile). */
  readonly profileId: string | null;
  /** A bot played for this human at some point (AFK or leave takeover). */
  readonly botAssisted: boolean;
  /** Left the game or their reconnection grace expired: a loss. */
  readonly forfeited: boolean;
}

export interface GameResultInput {
  readonly gameId: string;
  readonly roomId: string;
  readonly mode: GameMode;
  /** A 2v2 team game (seats 0+2 vs 1+3). Absent = a classic game. */
  readonly teams?: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly endReason: GameEndReason;
  readonly durakId: string | null;
  readonly seats: readonly ResultSeat[];
}

/** Abandoned and restarted games are stored for the history but never rated. */
export function endReasonIsRated(reason: GameEndReason): boolean {
  return reason === 'normal' || reason === 'forfeit';
}

/** The losing team of a finished team game (the durak's team), or null (no durak, or not a team game). */
export function losingTeamOf(input: GameResultInput): 0 | 1 | null {
  if (input.teams !== true || input.durakId === null) return null;
  const durak = input.seats.find((s) => s.playerId === input.durakId);
  return durak ? teamOfSeat(durak.seat) : null;
}

export function seatResult(input: GameResultInput, seat: ResultSeat): PlayerResult {
  if (seat.forfeited) return 'forfeit';
  if (input.durakId === seat.playerId) return 'durak';
  if (!endReasonIsRated(input.endReason)) return 'unfinished';
  if (input.durakId === null) return 'draw';
  // Teams: the durak's partner lost with the durak.
  if (input.teams === true && teamOfSeat(seat.seat) === losingTeamOf(input)) return 'teamLoss';
  return 'win';
}

export function isLoss(result: PlayerResult): boolean {
  return result === 'durak' || result === 'forfeit' || result === 'teamLoss';
}

/**
 * The seats that take part in the rating: humans with a profile, each profile once (the first
 * seat wins; RoomService already lets a profile hold only one seat per room, this is the backstop
 * that keeps a profile from ever being matched against itself).
 */
export function ratedSeats(input: GameResultInput): ResultSeat[] {
  const seen = new Set<string>();
  const seats: ResultSeat[] = [];
  for (const seat of input.seats) {
    if (seat.isBot || seat.profileId === null || seen.has(seat.profileId)) continue;
    seen.add(seat.profileId);
    seats.push(seat);
  }
  return seats;
}

/**
 * A team game is rated only when all four seats were humans with distinct profiles at the deal
 * (a bot partner would inflate the human's rating). A seat a bot took over later still counts as
 * its human's (botAssisted), as everywhere else.
 */
export function teamsHaveFourHumans(input: GameResultInput): boolean {
  return input.seats.length === TEAM_GAME_PLAYERS && ratedSeats(input).length === TEAM_GAME_PLAYERS;
}

/**
 * Rated iff it ended normally or by forfeit and at least two profiled humans played (team games:
 * all four seats profiled humans). Bots never count.
 */
export function isRated(input: GameResultInput): boolean {
  if (!endReasonIsRated(input.endReason)) return false;
  return input.teams === true ? teamsHaveFourHumans(input) : ratedSeats(input).length >= 2;
}

/**
 * New ratings for a rated game: profileId → rating after. `current` holds every rated profile's
 * rating before the game (read under a row lock in the same transaction that writes the result).
 */
export function ratingsAfter(input: GameResultInput, current: ReadonlyMap<string, number>): Map<string, number> {
  if (input.teams === true) {
    const teamPlayers: TeamEloPlayer[] = ratedSeats(input).map((seat) => {
      const rating = current.get(seat.profileId as string);
      if (rating === undefined) throw new Error(`ratingsAfter: no rating for ${seat.profileId}`);
      return { profileId: seat.profileId as string, rating, team: teamOfSeat(seat.seat), forfeited: seat.forfeited };
    });
    const deltas = teamEloDeltas(teamPlayers, losingTeamOf(input));
    return new Map(teamPlayers.map((p) => [p.profileId, p.rating + (deltas.get(p.profileId) ?? 0)]));
  }
  const players: EloPlayer[] = ratedSeats(input).map((seat) => {
    const rating = current.get(seat.profileId as string);
    if (rating === undefined) throw new Error(`ratingsAfter: no rating for ${seat.profileId}`);
    return { profileId: seat.profileId as string, rating, lost: isLoss(seatResult(input, seat)) };
  });
  const deltas = eloDeltas(players);
  return new Map(players.map((p) => [p.profileId, p.rating + (deltas.get(p.profileId) ?? 0)]));
}
