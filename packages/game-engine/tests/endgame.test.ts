import { describe, expect, it } from 'vitest';
import { getLegalMoves, getPlayersToAct } from '../src/index.js';
import { c, cards, expectError, handOf, idOf, makeState, play } from './helpers.js';

// All scenarios use an empty stock; trump suit: clubs.
describe('going out and the durak', () => {
  it('a player with no cards once the stock is empty is out; the last player holding cards is the durak', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S 8H' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.phase).toEqual({ kind: 'finished', durak: 'b' });
    expect(s.finishOrder).toEqual(['a']);
  });

  it('is a draw when the last two players go out in the same bout', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.phase).toEqual({ kind: 'finished', durak: null });
    expect(s.finishOrder).toEqual(['a', 'b']);
  });

  it('rejects every move once the game is finished', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S 8H' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expectError(s, { type: 'attack', playerId: 'b', card: c('8H') }, 'GAME_FINISHED');
    expect(getLegalMoves(s, 'b')).toEqual([]);
    expect(getPlayersToAct(s)).toEqual([]);
  });

  it('the game continues with the remaining players and skips those who are out', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S 9H', c: '8D 10D' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.finishOrder).toEqual(['a']);
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('c');

    s = play(s, { type: 'attack', playerId: 'b', card: c('9H') });
    expectError(s, { type: 'pass', playerId: 'a' }, 'PLAYER_FINISHED');
    s = play(s, { type: 'take', playerId: 'c' });
    expect(s.phase).toEqual({ kind: 'finished', durak: 'c' });
    expect(s.finishOrder).toEqual(['a', 'b']);
    expect(handOf(s, 'c')).toEqual(cards('8D 10D 9H'));
  });

  it('rotation after a take skips players who went out', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7H', c: '9D JD' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    expect(s.finishOrder).toEqual(['a']);
    expect(idOf(s, s.attackerIndex)).toBe('c');
    expect(idOf(s, s.defenderIndex)).toBe('b');
  });

  it('a defender who goes out passes the attack to the next player still in', () => {
    const s0 = makeState({
      hands: { a: '6S QD', b: '7S', c: '9D JD', d: '10H' },
      trump: 'AC',
      attacker: 'a',
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.finishOrder).toEqual(['b']);
    expect(idOf(s, s.attackerIndex)).toBe('c');
    expect(idOf(s, s.defenderIndex)).toBe('d');
  });

  it('emptying your hand while the stock still has cards does not take you out', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S QH' }, deck: '8D 9D AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.finishOrder).toEqual([]);
    expect(handOf(s, 'a')).toEqual(cards('8D 9D AC'));
    expect(s.phase.kind).toBe('awaitingAttack');
  });

  it('an attacker who ran out mid-bout can no longer act and does not block resolution', () => {
    const s0 = makeState({ hands: { a: '6S', b: '7S 8S AH', c: 'KD' }, trump: 'AC', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expect(getLegalMoves(s, 'a').filter((m) => m.type === 'attack')).toEqual([]);
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expect(s.phase.kind).toBe('awaitingAttack');
    expect(s.finishOrder).toEqual(['a']);
  });
});
