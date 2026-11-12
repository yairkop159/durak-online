import { describe, expect, it } from 'vitest';
import { getLegalMoves } from '../src/index.js';
import { c, expectError, handOf, makeState, play } from './helpers.js';

// Trump suit: clubs.
const withAttack = (attack: string, defenderHand = '9S 7S 6C 8H AC 10D') =>
  makeState({
    hands: { a: 'QD KD 8D', b: defenderHand },
    deck: '7D AD KC',
    trump: 'KC',
    table: [[attack, null]],
    attacker: 'a',
  });

describe('defending', () => {
  it('a higher card of the same suit covers', () => {
    const s = play(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') });
    expect(s.table[0]!.defense).toEqual(c('9S'));
    expect(handOf(s, 'b')).not.toContainEqual(c('9S'));
  });

  it('a lower card of the same suit does not', () => {
    expectError(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') }, 'CARD_DOES_NOT_BEAT');
  });

  it('any trump covers a non-trump', () => {
    const s = play(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('6C') });
    expect(s.table[0]!.defense).toEqual(c('6C'));
  });

  it('a card of another non-trump suit does not cover', () => {
    expectError(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('8H') }, 'CARD_DOES_NOT_BEAT');
  });

  it('a trump attack can only be covered by a higher trump', () => {
    expectError(withAttack('10C'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('6C') }, 'CARD_DOES_NOT_BEAT');
    expectError(withAttack('10C'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') }, 'CARD_DOES_NOT_BEAT');
    expect(() => play(withAttack('10C'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('AC') })).not.toThrow();
  });

  it('rejects a bad attack index or an already covered card', () => {
    expectError(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 3, card: c('9S') }, 'INVALID_ATTACK_INDEX');
    const s = makeState({
      hands: { a: '8D', b: '9S AC' },
      deck: '7D',
      trump: 'KC',
      table: [
        ['8S', '10S'],
        ['8H', null],
      ],
      attacker: 'a',
    });
    expectError(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('AC') }, 'ALREADY_COVERED');
  });

  it('only the defender may defend, with a card from their own hand', () => {
    expectError(withAttack('8S'), { type: 'defend', playerId: 'a', attackIndex: 0, card: c('QD') }, 'NOT_YOUR_TURN');
    expectError(withAttack('8S'), { type: 'defend', playerId: 'b', attackIndex: 0, card: c('AS') }, 'CARD_NOT_IN_HAND');
  });

  it('cannot defend after deciding to take', () => {
    const s = play(withAttack('8S'), { type: 'take', playerId: 'b' });
    expectError(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') }, 'INVALID_MOVE');
  });

  it('multiple attack cards may be covered in any order', () => {
    const s0 = makeState({
      hands: { a: 'QD', b: '9S 9H AC' },
      deck: '7D',
      trump: 'KC',
      table: [
        ['8S', null],
        ['8H', null],
      ],
      attacker: 'a',
    });
    let s = play(s0, { type: 'defend', playerId: 'b', attackIndex: 1, card: c('9H') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') });
    expect(s.table).toEqual([]); // nobody can throw in -> bout resolved, table cleared
    expect(s.discard).toHaveLength(4);
  });

  it('getLegalMoves for the defender lists exactly the beating cards plus take', () => {
    const moves = getLegalMoves(withAttack('8S'), 'b');
    const defends = moves.filter((m) => m.type === 'defend').map((m) => (m.type === 'defend' ? m.card : null));
    expect(defends).toEqual([c('9S'), c('6C'), c('AC')]);
    expect(moves.some((m) => m.type === 'take')).toBe(true);
    expect(moves.some((m) => m.type === 'transfer')).toBe(false);
  });
});
