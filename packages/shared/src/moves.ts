import { z } from 'zod';
import { CardSchema, type Card } from './cards.js';

export type PlayerId = string;

/**
 * Moves as sent by a client. They intentionally carry NO player id:
 * the server attaches the authenticated player's id from the session,
 * so a client can never act on behalf of somebody else.
 */
export const ClientMoveSchema = z.discriminatedUnion('type', [
  /** Open a bout (attacker) or throw in a card of a rank already on the table (any non-defender). */
  z.object({ type: z.literal('attack'), card: CardSchema }).strict(),
  /** Defender covers the attack card at `attackIndex`. */
  z
    .object({
      type: z.literal('defend'),
      attackIndex: z.number().int().min(0).max(5),
      card: CardSchema,
    })
    .strict(),
  /** Perevodnoy only: defender adds a card of the same rank and passes the bout to the next player. */
  z.object({ type: z.literal('transfer'), card: CardSchema }).strict(),
  /** Defender gives up and will pick up every card on the table. */
  z.object({ type: z.literal('take') }).strict(),
  /** A non-defender declares they are done throwing in for now. */
  z.object({ type: z.literal('pass') }).strict(),
]);

export type ClientMove = z.infer<typeof ClientMoveSchema>;
export type MoveType = ClientMove['type'];

/** A move bound to the (server-authenticated) player who makes it. */
export type Move = ClientMove & { readonly playerId: PlayerId };

export interface TablePair {
  readonly attack: Card;
  readonly defense: Card | null;
}
