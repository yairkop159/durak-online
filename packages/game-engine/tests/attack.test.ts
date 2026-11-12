import { describe, expect, it } from 'vitest';
import { canThrowIn, getLegalMoves } from '../src/index.js';
import { c, cards, expectError, handOf, makeState, play } from './helpers.js';

const base = () =>
  makeState({
    hands: { a: '6S 6C 7D 8H 9S', b: '7S 8S 9C 10D JH QH', c: '6D 6H 10S' },
    deck: 'AD AH KC',
    trump: 'KC',
    attacker: 'a',
    defender: 'b',
  });

describe('opening an attack', () => {
  it('only the attacker may open the bout', () => {
    expectError(base(), { type: 'attack', playerId: 'c', card: c('6D') }, 'NOT_YOUR_TURN');
    expectError(base(), { type: 'attack', playerId: 'b', card: c('7S') }, 'NOT_YOUR_TURN');
  });

  it('the card must be in the attacker hand', () => {
    expectError(base(), { type: 'attack', playerId: 'a', card: c('AS') }, 'CARD_NOT_IN_HAND');
  });

  it('nobody may pass, defend or take before the bout is opened', () => {
    expectError(base(), { type: 'pass', playerId: 'a' }, 'INVALID_MOVE');
    expectError(base(), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') }, 'INVALID_MOVE');
    expectError(base(), { type: 'take', playerId: 'b' }, 'INVALID_MOVE');
  });

  it('any card may lead; it moves from the hand to the table', () => {
    const s = play(base(), { type: 'attack', playerId: 'a', card: c('9S') });
    expect(s.table).toEqual([{ attack: c('9S'), defense: null }]);
    expect(handOf(s, 'a')).toEqual(cards('6S 6C 7D 8H'));
    expect(s.phase).toEqual({ kind: 'bout', taking: false, passed: [] });
  });

  it('does not mutate the previous state', () => {
    const s0 = base();
    const snapshot = JSON.stringify(s0);
    play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe('throwing in (podkidnoy)', () => {
  it('any non-defender may throw in a card whose rank is on the table', () => {
    const s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    const s2 = play(s, { type: 'attack', playerId: 'c', card: c('6D') });
    expect(s2.table.map((p) => p.attack)).toEqual(cards('6S 6D'));
  });

  it('rejects ranks that are not on the table', () => {
    const s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'attack', playerId: 'c', card: c('10S') }, 'RANK_NOT_ON_TABLE');
  });

  it('the defender cannot throw in', () => {
    const s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'attack', playerId: 'b', card: c('7S') }, 'NOT_YOUR_TURN');
  });

  it('ranks of defending cards may also be thrown in', () => {
    let s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    s = play(s, { type: 'attack', playerId: 'a', card: c('7D') });
    expect(s.table).toHaveLength(2);
  });

  it('uncovered cards may never exceed the defender hand size', () => {
    const s0 = makeState({
      hands: { a: '6S 6C 6D', b: 'AH KH' },
      deck: '7S 8S',
      trump: '8S',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'attack', playerId: 'a', card: c('6C') });
    expectError(s, { type: 'attack', playerId: 'a', card: c('6D') }, 'TABLE_LIMIT_REACHED');
    expect(canThrowIn(s, 0)).toBe(false);
  });

  it('the first bout is limited to five attack cards (classic rule)', () => {
    const spec = {
      hands: { a: '9S', b: 'AD AC', c: '' },
      deck: '7D',
      trump: '7D',
      table: [
        ['9H', '10H'],
        ['9C', '10C'],
        ['9D', '10D'],
        ['10S', 'JS'],
        ['JH', 'QH'],
      ] as [string, string | null][],
      attacker: 'a',
      defender: 'b',
    };
    expectError(makeState({ ...spec, boutNumber: 1 }), { type: 'attack', playerId: 'a', card: c('9S') }, 'TABLE_LIMIT_REACHED');
    expect(() => play(makeState({ ...spec, boutNumber: 2 }), { type: 'attack', playerId: 'a', card: c('9S') })).not.toThrow();
  });

  it('later bouts are limited to six attack cards', () => {
    const s = makeState({
      hands: { a: '9S', b: 'AD AC' },
      deck: '7D',
      trump: '7D',
      table: [
        ['9H', '10H'],
        ['9C', '10C'],
        ['9D', '10D'],
        ['10S', 'JS'],
        ['JH', 'QH'],
        ['JC', 'QC'],
      ],
      attacker: 'a',
      boutNumber: 4,
    });
    expectError(s, { type: 'attack', playerId: 'a', card: c('9S') }, 'TABLE_LIMIT_REACHED');
  });

  it('respects a custom first-bout limit from config', () => {
    const s0 = makeState({
      hands: { a: '6S 6C', b: 'AD AC KD' },
      deck: '7D',
      trump: '7D',
      attacker: 'a',
      boutNumber: 1,
      config: { firstBoutMaxCards: 1 },
    });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'attack', playerId: 'a', card: c('6C') }, 'TABLE_LIMIT_REACHED');
  });
});

describe('player validation', () => {
  it('rejects unknown players', () => {
    expectError(base(), { type: 'attack', playerId: 'zed', card: c('6S') }, 'UNKNOWN_PLAYER');
  });

  it('rejects players who are already out', () => {
    const s0 = makeState({
      hands: { a: '6S', b: '7S 8S', c: '' },
      trump: 'KC',
      attacker: 'a',
      defender: 'b',
      finishOrder: ['c'],
    });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'pass', playerId: 'c' }, 'PLAYER_FINISHED');
  });

  it('getLegalMoves for the attacker before the bout lists every card', () => {
    const moves = getLegalMoves(base(), 'a');
    expect(moves).toHaveLength(5);
    expect(moves.every((m) => m.type === 'attack')).toBe(true);
    expect(getLegalMoves(base(), 'b')).toEqual([]);
    expect(getLegalMoves(base(), 'c')).toEqual([]);
  });
});
