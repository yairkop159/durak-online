import { z } from 'zod';
import { RoomIdSchema } from './events.js';

/**
 * `game:ratings` (server → client): the rating outcome of a finished game. The ELO write to Postgres
 * happens after `game:over`, so the game-over screen learns about it separately:
 * - `pending`: the game will be rated; the write has not committed yet.
 * - `rated`: the write committed (sent once, after the commit); one entry per rated human.
 * - `unrated`: the game is not rated, and why.
 * Nothing is sent when ratings are off or Postgres is down when the game ends.
 * Re-sent with the finished game's `game:state` on `session:resume`, so a reload keeps it.
 */
export const UNRATED_REASONS = [
  /** Fewer than two humans with a profile played (bots are never rated). */
  'notEnoughProfiles',
  /** The game was abandoned or restarted. */
  'notFinished',
] as const;
export type UnratedReason = (typeof UNRATED_REASONS)[number];

const GameIdSchema = z.string().min(1).max(64);

export const RatingEntrySchema = z
  .object({
    playerId: z.string().min(1).max(64),
    before: z.number().int(),
    after: z.number().int(),
    delta: z.number().int(),
  })
  .strict()
  .refine((e) => e.after - e.before === e.delta, 'delta must equal after - before');
export type RatingEntry = z.infer<typeof RatingEntrySchema>;

export const GameRatingsPayloadSchema = z.discriminatedUnion('status', [
  z.object({ roomId: RoomIdSchema, gameId: GameIdSchema, status: z.literal('pending') }).strict(),
  z
    .object({ roomId: RoomIdSchema, gameId: GameIdSchema, status: z.literal('unrated'), reason: z.enum(UNRATED_REASONS) })
    .strict(),
  z
    .object({ roomId: RoomIdSchema, gameId: GameIdSchema, status: z.literal('rated'), entries: z.array(RatingEntrySchema).min(2).max(6) })
    .strict(),
]);
export type GameRatingsPayload = z.infer<typeof GameRatingsPayloadSchema>;
export type RatingStatus = GameRatingsPayload['status'];

/** A rating entry from a rating before and after (the delta is derived, never stored separately). */
export function ratingEntry(playerId: string, before: number, after: number): RatingEntry {
  return { playerId, before, after, delta: after - before };
}
