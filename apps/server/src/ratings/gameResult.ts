import type { GameEndReason, GameMode, PlayerResult } from '@durak/shared';
import { eloDeltas, type EloPlayer } from './elo.js';

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

export function seatResult(input: GameResultInput, seat: ResultSeat): PlayerResult {
  if (seat.forfeited) return 'forfeit';
  if (input.durakId === seat.playerId) return 'durak';
  if (!endReasonIsRated(input.endReason)) return 'unfinished';
  if (input.durakId === null) return 'draw';
  return 'win';
}

export function isLoss(result: PlayerResult): boolean {
  return result === 'durak' || result === 'forfeit';
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

/** Rated iff it ended normally or by forfeit and at least two profiled humans played. Bots never count. */
export function isRated(input: GameResultInput): boolean {
  return endReasonIsRated(input.endReason) && ratedSeats(input).length >= 2;
}

/**
 * New ratings for a rated game: profileId → rating after. `current` holds every rated profile's
 * rating before the game (read under a row lock in the same transaction that writes the result).
 */
export function ratingsAfter(input: GameResultInput, current: ReadonlyMap<string, number>): Map<string, number> {
  const players: EloPlayer[] = ratedSeats(input).map((seat) => {
    const rating = current.get(seat.profileId as string);
    if (rating === undefined) throw new Error(`ratingsAfter: no rating for ${seat.profileId}`);
    return { profileId: seat.profileId as string, rating, lost: isLoss(seatResult(input, seat)) };
  });
  const deltas = eloDeltas(players);
  return new Map(players.map((p) => [p.profileId, p.rating + (deltas.get(p.profileId) ?? 0)]));
}
