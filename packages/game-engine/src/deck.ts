import { RANKS, SUITS, sameCard, type Card, type Suit } from '@durak/shared';

/** A fresh, ordered 36-card deck. */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/** True if `defense` beats `attack` given the trump suit. */
export function beats(attack: Card, defense: Card, trump: Suit): boolean {
  if (defense.suit === attack.suit) return defense.rank > attack.rank;
  return defense.suit === trump && attack.suit !== trump;
}

export function indexOfCard(cards: readonly Card[], card: Card): number {
  return cards.findIndex((c) => sameCard(c, card));
}

export function hasCard(cards: readonly Card[], card: Card): boolean {
  return indexOfCard(cards, card) !== -1;
}

/** Returns a copy of `cards` without the first occurrence of `card`. */
export function removeCard(cards: readonly Card[], card: Card): Card[] {
  const idx = indexOfCard(cards, card);
  if (idx === -1) return cards.slice();
  return [...cards.slice(0, idx), ...cards.slice(idx + 1)];
}
