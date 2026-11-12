import { describe, expect, it } from 'vitest';
import { beats, createDeck, createRng, removeCard, shuffle } from '../src/index.js';
import { c, cards, isFullDeckPermutation } from './helpers.js';

describe('createDeck', () => {
  it('produces 36 unique cards from 6 to Ace in four suits', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(36);
    expect(isFullDeckPermutation(deck)).toBe(true);
    expect(Math.min(...deck.map((x) => x.rank))).toBe(6);
    expect(Math.max(...deck.map((x) => x.rank))).toBe(14);
  });
});

describe('PRNG and shuffle', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces values in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('shuffle returns a permutation and does not mutate the input', () => {
    const deck = createDeck();
    const before = JSON.stringify(deck);
    const shuffled = shuffle(deck, createRng(99));
    expect(JSON.stringify(deck)).toBe(before);
    expect(isFullDeckPermutation(shuffled)).toBe(true);
    expect(shuffled).not.toEqual(deck);
  });

  it('different seeds give different orders, same seeds give the same order', () => {
    const deck = createDeck();
    expect(shuffle(deck, createRng(1))).toEqual(shuffle(deck, createRng(1)));
    expect(shuffle(deck, createRng(1))).not.toEqual(shuffle(deck, createRng(2)));
  });

  it('distributes the top card roughly uniformly', () => {
    const counts = new Map<string, number>();
    const rng = createRng(2024);
    const trials = 36_000;
    for (let i = 0; i < trials; i++) {
      const top = shuffle(createDeck(), rng)[0]!;
      const key = `${top.rank}${top.suit}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(36);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });
});

describe('beats', () => {
  const trump = 'C' as const;

  it('higher card of the same suit beats', () => {
    expect(beats(c('8S'), c('9S'), trump)).toBe(true);
    expect(beats(c('8S'), c('AS'), trump)).toBe(true);
  });

  it('lower or equal card of the same suit does not beat', () => {
    expect(beats(c('8S'), c('7S'), trump)).toBe(false);
    expect(beats(c('8S'), c('8S'), trump)).toBe(false);
  });

  it('any trump beats any non-trump', () => {
    expect(beats(c('AS'), c('6C'), trump)).toBe(true);
  });

  it('a different non-trump suit never beats', () => {
    expect(beats(c('6S'), c('AH'), trump)).toBe(false);
  });

  it('trumps compare by rank; non-trumps cannot beat a trump', () => {
    expect(beats(c('10C'), c('JC'), trump)).toBe(true);
    expect(beats(c('10C'), c('9C'), trump)).toBe(false);
    expect(beats(c('6C'), c('AS'), trump)).toBe(false);
  });
});

describe('removeCard', () => {
  it('removes exactly one matching card and leaves the input intact', () => {
    const hand = cards('6S 7S 8S');
    expect(removeCard(hand, c('7S'))).toEqual(cards('6S 8S'));
    expect(hand).toEqual(cards('6S 7S 8S'));
    expect(removeCard(hand, c('AH'))).toEqual(hand);
  });
});
