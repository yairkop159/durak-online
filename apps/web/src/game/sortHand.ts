import { SUITS, type Card, type Suit } from '@durak/shared';

/**
 * Display order for a hand: non-trumps grouped by suit (S, C, D, H) and ascending rank,
 * then the trumps, ascending. Returns a new array.
 */
export function sortHand(hand: readonly Card[], trump: Suit): Card[] {
  const key = (card: Card) => (card.suit === trump ? 4 : SUITS.indexOf(card.suit)) * 100 + card.rank;
  return [...hand].sort((a, b) => key(a) - key(b));
}
