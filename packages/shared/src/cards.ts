import { z } from 'zod';

/** Suits: Spades, Clubs, Diamonds, Hearts. */
export const SUITS = ['S', 'C', 'D', 'H'] as const;
export type Suit = (typeof SUITS)[number];

/** Ranks of the 36-card deck: 6..10, J=11, Q=12, K=13, A=14. */
export const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Rank = (typeof RANKS)[number];

export const SuitSchema = z.enum(SUITS);
export const RankSchema = z.union([
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
  z.literal(11),
  z.literal(12),
  z.literal(13),
  z.literal(14),
]);

export const CardSchema = z
  .object({
    suit: SuitSchema,
    rank: RankSchema,
  })
  .strict();

export interface Card {
  readonly suit: Suit;
  readonly rank: Rank;
}

export const HAND_SIZE = 6;
export const DECK_SIZE = SUITS.length * RANKS.length;

const RANK_LABELS: Record<Rank, string> = {
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

/** Compact, human-readable id such as "10H" or "AS". */
export function cardId(card: Card): string {
  return `${RANK_LABELS[card.rank]}${card.suit}`;
}

export function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}
