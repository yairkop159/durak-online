/**
 * Executable version of the "Rules Specification" section in CLAUDE.md.
 * Each describe block names the spec rule it pins down.
 */
import { describe, expect, it } from 'vitest';
import { drawOrder } from '../src/index.js';
import { c, cards, handOf, idOf, makeState, play } from './helpers.js';

const ids = (state: Parameters<typeof drawOrder>[0], order: number[]) => order.map((i) => idOf(state, i));

describe('spec: transfer makes the transferring player the main attacker (draw order)', () => {
  // Trump: diamonds (AD is the bottom card).
  it('3 players: b transfers to c, c defends; b draws first, a second, c last; c attacks next', () => {
    const s0 = makeState({
      hands: { a: '6S 9C', b: '6H 9H 10C', c: '7S 8H JS QS' },
      deck: 'JH QH KH AH KD AD',
      attacker: 'a',
      config: { mode: 'perevodnoy' },
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('c');
    expect(ids(s, drawOrder(s))).toEqual(['b', 'a', 'c']);

    s = play(s, { type: 'defend', playerId: 'c', attackIndex: 0, card: c('7S') });
    s = play(s, { type: 'defend', playerId: 'c', attackIndex: 1, card: c('8H') });

    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    expect(s.discard).toEqual(cards('6S 7S 6H 8H'));
    expect(handOf(s, 'b')).toEqual(cards('9H 10C JH QH KH AH')); // drew 4 first
    expect(handOf(s, 'a')).toEqual(cards('9C KD AD')); // drew the remaining 2
    expect(handOf(s, 'c')).toEqual(cards('JS QS')); // defender last: stock already empty
    expect(idOf(s, s.attackerIndex)).toBe('c');
    expect(idOf(s, s.defenderIndex)).toBe('a');
  });

  it('4 players: after b transfers to c the draw order is b, d, a, then the defender c', () => {
    const s0 = makeState({
      hands: { a: '6S 9C', b: '6H 9H', c: '7S 8H JS', d: '10D' },
      deck: 'JH QH AD',
      attacker: 'a',
      config: { mode: 'perevodnoy' },
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    expect(ids(s, drawOrder(s))).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('spec: 2-player transfer bounces back to the original attacker', () => {
  it('a attacks, b transfers back; a takes; b draws first and attacks again', () => {
    const s0 = makeState({
      hands: { a: '6S 7D 8D', b: '6H 8C 9C' },
      deck: 'JH QH KH AH KD AD',
      attacker: 'a',
      config: { mode: 'perevodnoy' },
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('a');

    s = play(s, { type: 'take', playerId: 'a' }); // b holds no 6: bout ends at once
    expect(handOf(s, 'b')).toEqual(cards('8C 9C JH QH KH AH'));
    expect(handOf(s, 'a')).toEqual(cards('7D 8D 6S 6H KD AD'));
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('a');
  });
});

describe('spec: the bout ends immediately when nothing more can happen', () => {
  it('on the covering move, if no non-defender can throw in (nobody has to pass)', () => {
    const s0 = makeState({
      hands: { a: '6S 9D', b: '7S KH', c: '10C' },
      deck: 'JS JD AH',
      attacker: 'a',
    });
    const s1 = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expect(s1.phase).toEqual({ kind: 'bout', taking: false, passed: [] });
    const s2 = play(s1, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s2.phase).toEqual({ kind: 'awaitingAttack' });
    expect(s2.table).toEqual([]);
    expect(s2.discard).toEqual(cards('6S 7S'));
  });

  it('on take, if the uncovered-card limit blocks every throw-in (even with matching ranks held)', () => {
    const s0 = makeState({
      hands: { a: '6S 6D', b: '7H', c: '6C' },
      deck: 'QD KS',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    expect(handOf(s, 'b')).toEqual(cards('7H 6S'));
  });
});

describe('spec: draw when the last players empty their hands in the same bout', () => {
  it('3 players, one already out: the last two go out together -> durak is null', () => {
    const s0 = makeState({
      hands: { a: '6S', b: '7S', c: '' },
      trump: 'AC',
      attacker: 'a',
      defender: 'b',
      finishOrder: ['c'],
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.phase).toEqual({ kind: 'finished', durak: null });
    expect(s.finishOrder).toEqual(['c', 'a', 'b']);
  });
});
