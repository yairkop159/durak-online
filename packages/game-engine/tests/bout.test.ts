import { describe, expect, it } from 'vitest';
import { drawOrder } from '../src/index.js';
import { c, cards, expectError, handOf, idOf, makeState, play } from './helpers.js';

describe('bout resolution after a successful defense', () => {
  it('resolves automatically when nobody can throw in, discarding the table', () => {
    const s0 = makeState({
      hands: { a: '6S 9D', b: '7S KH QH', c: '8D 10H' },
      deck: 'JS JD JC QS QD QC KS KD KC',
      attacker: 'a',
      defender: 'b',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });

    expect(s.table).toEqual([]);
    expect(s.discard).toEqual(cards('6S 7S'));
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    expect(s.boutNumber).toBe(3);
    // The successful defender attacks next, against the next player clockwise.
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('c');
  });

  it('waits until every attacker who could throw in has passed', () => {
    const s0 = makeState({
      hands: { a: '6S 7D', b: '7S KH QH', c: '8D 10H' },
      deck: 'JS JD JC QS QD QC KS KD KC',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.table).toHaveLength(1); // a could still throw 7D
    expect(s.phase.kind).toBe('bout');
    s = play(s, { type: 'pass', playerId: 'a' });
    expect(s.table).toEqual([]);
    expect(s.phase.kind).toBe('awaitingAttack');
  });

  it('a new card on the table resets earlier passes', () => {
    const s0 = makeState({
      hands: { a: '6S 7D 8S', b: '7S 8D KH QH AS', c: '8C 10D' },
      deck: 'JS JD JC QS QD QC KS KD KH',
      trump: 'KH',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(s.phase).toEqual({ kind: 'bout', taking: false, passed: ['c'] });
    expectError(s, { type: 'pass', playerId: 'c' }, 'ALREADY_PASSED');

    s = play(s, { type: 'attack', playerId: 'a', card: c('7D') });
    expect(s.phase).toEqual({ kind: 'bout', taking: false, passed: [] });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 1, card: c('8D') });
    // Rank 8 is now on the table: both a (8S) and c (8C) may throw in again.
    s = play(s, { type: 'pass', playerId: 'a' });
    expect(s.phase.kind).toBe('bout');
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(s.phase.kind).toBe('awaitingAttack');
    expect(s.discard).toEqual(cards('6S 7S 7D 8D'));
  });

  it('the defender cannot pass', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S 8S' }, deck: '9D AD', attacker: 'a' });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'pass', playerId: 'b' }, 'NOT_YOUR_TURN');
  });

  it('the bout does not end while a card is uncovered, even if everyone passed', () => {
    const s0 = makeState({ hands: { a: '6S 9D', b: '7S 8S', c: '10D' }, deck: '9H AD', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'pass', playerId: 'a' });
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(s.table).toHaveLength(1);
    expect(s.phase.kind).toBe('bout');
  });
});

describe('drawing cards', () => {
  it('main attacker draws first, then the others clockwise, defender last', () => {
    const s0 = makeState({
      hands: { a: '6S 9D', b: '7S KH QH', c: '8D 10H' },
      deck: 'JS JD JC QS QD QC KS KD KC',
      attacker: 'a',
      defender: 'b',
    });
    expect(drawOrder(s0).map((i) => idOf(s0, i))).toEqual(['a', 'c', 'b']);

    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    // a refills to 6 first (5 cards), c takes the remaining 4, the defender gets nothing.
    expect(handOf(s, 'a')).toEqual(cards('9D JS JD JC QS QD'));
    expect(handOf(s, 'c')).toEqual(cards('8D 10H QC KS KD KC'));
    expect(handOf(s, 'b')).toEqual(cards('KH QH'));
    expect(s.deck).toEqual([]);
  });

  it('the face-up trump card is the very last card drawn', () => {
    const s0 = makeState({
      hands: { a: '6S QS 8H 9H 10H JH', b: '7S 8D 9D 10D JD QD' },
      deck: 'AS AC',
      trump: 'AC',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(handOf(s, 'a')[5]).toEqual(c('AS'));
    expect(handOf(s, 'b')[5]).toEqual(c('AC'));
    expect(s.deck).toEqual([]);
  });

  it('nobody draws above six cards', () => {
    const s0 = makeState({
      hands: { a: '6S QS 8H 9H 10H JH QH', b: '7S 8D 9D 10D JD QD KD' },
      deck: 'AS AC',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(handOf(s, 'a')).toHaveLength(6);
    expect(handOf(s, 'b')).toHaveLength(6);
    expect(s.deck).toHaveLength(2);
  });
});

// Regression (Phase 5b): a closing defense or throw-in ends the bout inside the same applyMove,
// so it never appeared on any table. `lastBout` keeps the final table public.
describe('lastBout: public summary of the last resolved bout', () => {
  const twoPlayers = () =>
    makeState({
      hands: { a: '6S 9D', b: '7S KH QH', c: '8D 10H' },
      deck: 'JS JD JC QS QD QC KS KD KC',
      attacker: 'a',
      defender: 'b',
    });

  it('is null until a bout resolves', () => {
    expect(twoPlayers().lastBout).toBeNull();
    expect(play(twoPlayers(), { type: 'attack', playerId: 'a', card: c('6S') }).lastBout).toBeNull();
  });

  it('includes the defense that covered the last card and ended the bout', () => {
    let s = play(twoPlayers(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.table).toEqual([]);
    expect(s.lastBout).toEqual({
      table: [{ attack: c('6S'), defense: c('7S') }],
      outcome: 'beaten',
      defenderId: 'b',
    });
  });

  it('records a take with every table card, covered or not', () => {
    const s0 = makeState({
      hands: { a: '6S 6H 9D', b: '7S KH QH', c: '8D 10H' },
      deck: 'JS JD JC QS QD QC KS KD KC',
      attacker: 'a',
      defender: 'b',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    s = play(s, { type: 'attack', playerId: 'a', card: c('6H') });
    // Nobody can throw in any more, so the take ends the bout at once.
    s = play(s, { type: 'take', playerId: 'b' });
    expect(s.table).toEqual([]);
    expect(s.lastBout).toEqual({
      table: [
        { attack: c('6S'), defense: c('7S') },
        { attack: c('6H'), defense: null },
      ],
      outcome: 'taken',
      defenderId: 'b',
    });
    expect(handOf(s, 'b')).toEqual(expect.arrayContaining(cards('6S 7S 6H')));
  });

  it('survives the next opening attack and is replaced by the next resolution', () => {
    let s = play(twoPlayers(), { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    const first = s.lastBout;
    const opener = handOf(s, 'b')[0]!;
    s = play(s, { type: 'attack', playerId: 'b', card: opener });
    expect(s.lastBout).toEqual(first);
    s = play(s, { type: 'take', playerId: 'c' });
    expect(s.lastBout).toEqual({ table: [{ attack: opener, defense: null }], outcome: 'taken', defenderId: 'c' });
  });
});
