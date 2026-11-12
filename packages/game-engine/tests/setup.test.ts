import { describe, expect, it } from 'vitest';
import { createDeck, createGame, createGameWithDeck } from '../src/index.js';
import { allCards, c, cards, idOf, isFullDeckPermutation, stackedDeck } from './helpers.js';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

describe('createGame', () => {
  it.each([2, 3, 4, 5, 6])('deals six cards to each of %i players and conserves the deck', (n) => {
    const result = createGame({ playerIds: ids(n), seed: 42 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;
    for (const p of state.players) expect(p.hand).toHaveLength(6);
    expect(state.deck).toHaveLength(36 - 6 * n);
    expect(isFullDeckPermutation(allCards(state))).toBe(true);
    expect(state.phase).toEqual({ kind: 'awaitingAttack' });
    expect(state.boutNumber).toBe(1);
    expect(state.defenderIndex).toBe((state.attackerIndex + 1) % n);
  });

  it('the trump card is the bottom card of the stock', () => {
    const result = createGame({ playerIds: ids(3), seed: 5 });
    if (!result.ok) throw new Error('setup failed');
    expect(result.value.deck[result.value.deck.length - 1]).toEqual(result.value.trumpCard);
  });

  it('with six players the stock is empty and the trump card is the last card dealt', () => {
    const result = createGame({ playerIds: ids(6), seed: 11 });
    if (!result.ok) throw new Error('setup failed');
    const state = result.value;
    expect(state.deck).toHaveLength(0);
    const lastHand = state.players[5]!.hand;
    expect(lastHand[lastHand.length - 1]).toEqual(state.trumpCard);
  });

  it('is fully deterministic for the same seed', () => {
    const a = createGame({ playerIds: ids(4), seed: 777 });
    const b = createGame({ playerIds: ids(4), seed: 777 });
    const d = createGame({ playerIds: ids(4), seed: 778 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(d);
  });

  it('applies config defaults and overrides', () => {
    const def = createGame({ playerIds: ids(2), seed: 1 });
    const custom = createGame({ playerIds: ids(2), seed: 1, config: { mode: 'perevodnoy', firstBoutMaxCards: 6 } });
    if (!def.ok || !custom.ok) throw new Error('setup failed');
    expect(def.value.config).toEqual({ mode: 'podkidnoy', firstBoutMaxCards: 5, boutMaxCards: 6 });
    expect(custom.value.config).toEqual({ mode: 'perevodnoy', firstBoutMaxCards: 6, boutMaxCards: 6 });
  });

  it.each([0, 1, 7])('rejects %i players', (n) => {
    const result = createGame({ playerIds: ids(n), seed: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PLAYER_COUNT');
  });

  it('rejects duplicate or empty player ids', () => {
    for (const playerIds of [['a', 'a'], ['a', '']]) {
      const result = createGame({ playerIds, seed: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DUPLICATE_PLAYER');
    }
  });

  it('rejects an invalid config', () => {
    const result = createGame({ playerIds: ids(2), seed: 1, config: { firstBoutMaxCards: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_CONFIG');
  });

  it('rejects an incomplete or duplicated deck', () => {
    const short = createGameWithDeck(ids(2), createDeck().slice(1));
    const dup = createDeck();
    dup[0] = dup[1]!;
    const duplicated = createGameWithDeck(ids(2), dup);
    expect(short.ok).toBe(false);
    expect(duplicated.ok).toBe(false);
  });
});

describe('first attacker selection', () => {
  // Round-robin dealing with 2 players: even positions go to p0, odd positions to p1.
  it('the player with the lowest trump attacks first', () => {
    const deck = stackedDeck('7H 6H 8S 9S 10S JS QS KS AS 6C 7C 8C', 'AH');
    const result = createGameWithDeck(ids(2), deck);
    if (!result.ok) throw new Error('setup failed');
    expect(result.value.trumpCard).toEqual(c('AH'));
    expect(result.value.players[1]!.hand).toContainEqual(c('6H'));
    expect(result.value.attackerIndex).toBe(1);
    expect(result.value.defenderIndex).toBe(0);
  });

  it('lowest trump wins even if another player holds more trumps', () => {
    const deck = stackedDeck('8H 7H 9H 6S 10H 7S QH 8S KH 9S AS 10S', 'JH');
    const result = createGameWithDeck(ids(2), deck);
    if (!result.ok) throw new Error('setup failed');
    expect(result.value.attackerIndex).toBe(1);
  });

  it('falls back to the lowest card overall when nobody holds a trump', () => {
    const deck = stackedDeck('7S 6C 8S 9S 10S JS QS KS AS 7C 8C 9C', 'AH');
    const result = createGameWithDeck(ids(2), deck);
    if (!result.ok) throw new Error('setup failed');
    expect(result.value.attackerIndex).toBe(1);
  });

  it('breaks equal-rank ties by suit order S, C, D, H', () => {
    const deck = stackedDeck('6C 6S 7S 7C 8S 8C 9S 9C 10S 10C JS JC', 'AH');
    const result = createGameWithDeck(ids(2), deck);
    if (!result.ok) throw new Error('setup failed');
    expect(idOf(result.value, result.value.attackerIndex)).toBe('p1');
    expect(result.value.players[1]!.hand).toEqual(cards('6S 7C 8C 9C 10C JC'));
  });
});
