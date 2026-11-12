import { describe, expect, it } from 'vitest';
import { c, cards, expectError, handOf, idOf, makeState, play } from './helpers.js';

// Trump suit: spades.
const base = () =>
  makeState({
    hands: { a: '6S 6D 9C', b: '7H 8H', c: '6C JD' },
    deck: 'QD QC KD KC AS',
    attacker: 'a',
    defender: 'b',
  });

describe('taking', () => {
  it('only the defender may take, and only with an uncovered card on the table', () => {
    const s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'take', playerId: 'a' }, 'NOT_YOUR_TURN');
    expectError(s, { type: 'take', playerId: 'c' }, 'NOT_YOUR_TURN');

    const covered = makeState({
      hands: { a: '6D', b: '7H AS', c: '6C' },
      deck: 'QD KS',
      table: [['8H', '9H']],
      attacker: 'a',
    });
    expectError(covered, { type: 'take', playerId: 'b' }, 'INVALID_MOVE');
  });

  it('cannot take twice', () => {
    let s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' }); // a can still throw in 6D, so the bout stays open
    expect(s.phase).toEqual({ kind: 'bout', taking: true, passed: [] });
    expectError(s, { type: 'take', playerId: 'b' }, 'INVALID_MOVE');
  });

  it('attackers may keep throwing in after a take, up to the defender hand size', () => {
    let s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    expect(s.phase.kind).toBe('bout');
    s = play(s, { type: 'attack', playerId: 'a', card: c('6D') });
    // b holds 2 cards and 2 are now uncovered: c's 6C no longer fits, so the bout ends at once
    // and the defender picks everything up.
    expect(s.table).toEqual([]);
    expect(handOf(s, 'b')).toEqual(cards('7H 8H 6S 6D'));
    expect(s.discard).toEqual([]);
  });

  it('rejects throw-ins during a take beyond the defender hand size', () => {
    const s = makeState({
      hands: { a: '9C', b: '7H 8H', c: '6C JD' },
      deck: 'QD AS',
      table: [
        ['6S', null],
        ['6D', null],
      ],
      phase: { kind: 'bout', taking: true, passed: [] },
      attacker: 'a',
    });
    expectError(s, { type: 'attack', playerId: 'c', card: c('6C') }, 'TABLE_LIMIT_REACHED');
  });

  it('after a take, the defender is skipped: the next player attacks', () => {
    let s = play(base(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    s = play(s, { type: 'attack', playerId: 'a', card: c('6D') });
    expect(idOf(s, s.attackerIndex)).toBe('c');
    expect(idOf(s, s.defenderIndex)).toBe('a');
    // Draw: a refills first and empties the stock; the taker draws last (nothing left).
    expect(handOf(s, 'a')).toEqual(cards('9C QD QC KD KC AS'));
    expect(handOf(s, 'c')).toEqual(cards('6C JD'));
    expect(s.deck).toEqual([]);
  });

  it('defended cards are also picked up when taking', () => {
    const s0 = makeState({
      hands: { a: '8D QC', b: '7H 9D 10S' },
      deck: 'KD KC AS',
      table: [['8H', '9H']],
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('8D') });
    s = play(s, { type: 'take', playerId: 'b' });
    expect(handOf(s, 'b')).toEqual(cards('7H 9D 10S 8H 9H 8D'));
  });

  it('in a two-player game the same attacker attacks again after a take', () => {
    const s0 = makeState({ hands: { a: '6S 7S', b: '6H' }, deck: '8D 9D AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' }); // b holds 1 card: no room for throw-ins
    expect(handOf(s, 'b')).toEqual(cards('6H 6S'));
    expect(handOf(s, 'a')).toEqual(cards('7S 8D 9D AC'));
    expect(idOf(s, s.attackerIndex)).toBe('a');
    expect(idOf(s, s.defenderIndex)).toBe('b');
  });

  it('passing during a take resets when a new card is thrown in', () => {
    const s0 = makeState({
      hands: { a: '6S 6D 9C', b: '7H 8H 10H JH', c: '6C 9D' },
      deck: 'QD KS',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    s = play(s, { type: 'pass', playerId: 'a' });
    s = play(s, { type: 'attack', playerId: 'c', card: c('6C') });
    expect(s.phase).toEqual({ kind: 'bout', taking: true, passed: [] });
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(s.phase.kind).toBe('bout'); // a may throw in 6D again
    s = play(s, { type: 'pass', playerId: 'a' });
    expect(s.phase.kind).toBe('awaitingAttack');
    expect(handOf(s, 'b')).toEqual(cards('7H 8H 10H JH 6S 6C'));
  });
});
