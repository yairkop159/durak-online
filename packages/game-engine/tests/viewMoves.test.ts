import type { ClientMove, Move } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { getLegalMoves, getLegalMovesForView, sanitizeStateForPlayer, type GameState } from '../src/index.js';
import { c, makeState, play } from './helpers.js';

function viewMoves(state: GameState, id: string | null): ClientMove[] {
  return getLegalMovesForView(sanitizeStateForPlayer(state, id));
}

function stripped(moves: Move[]): ClientMove[] {
  return moves.map(({ playerId: _playerId, ...m }) => m as ClientMove);
}

describe('getLegalMovesForView', () => {
  it('lets only the attacker open, with any card', () => {
    const s = makeState({ hands: { a: '6S 9C', b: '7H 8C' }, deck: 'QH AD', attacker: 'a' });
    expect(viewMoves(s, 'a')).toEqual([
      { type: 'attack', card: c('6S') },
      { type: 'attack', card: c('9C') },
    ]);
    expect(viewMoves(s, 'b')).toEqual([]);
    expect(viewMoves(s, null)).toEqual([]);
  });

  it('offers throw-ins while the defender is taking, up to the defender hand size', () => {
    const s0 = makeState({ hands: { a: '6S 6C 6D', b: '7H 8H', c: 'KS' }, deck: 'QH AD', attacker: 'a', defender: 'b' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'take', playerId: 'b' });
    expect(viewMoves(s, 'a')).toEqual([
      { type: 'attack', card: c('6C') },
      { type: 'attack', card: c('6D') },
      { type: 'pass' },
    ]);
    expect(viewMoves(s, 'b')).toEqual([]);
    expect(viewMoves(s, 'a')).toEqual(stripped(getLegalMoves(s, 'a')));
  });

  it('allows no throw-in beyond the defender hand size', () => {
    const s0 = makeState({ hands: { a: '6S 6C', b: '7H', c: 'KS' }, deck: 'QH AD', attacker: 'a', defender: 'b' });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    // 1 uncovered card, defender holds 1: only pass is left.
    expect(viewMoves(s, 'a')).toEqual([{ type: 'pass' }]);
    expect(viewMoves(s, 'b')).toEqual([{ type: 'take' }]);
  });

  it('drops pass once the player has passed', () => {
    const s0 = makeState({ hands: { a: '6S 9C', b: '7H 8C', c: 'KS' }, deck: 'QH AD', attacker: 'a' });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(viewMoves(s, 'c')).toEqual([]);
  });

  it('limits transfers by the next player hand size', () => {
    const s0 = makeState({
      hands: { a: '6S 9C', b: '6H 7S', c: 'JS' },
      deck: 'QH AD',
      attacker: 'a',
      config: { mode: 'perevodnoy' },
    });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    // Transfer would put 2 cards on c, who holds 1.
    expect(viewMoves(s, 'b')).toEqual([
      { type: 'defend', attackIndex: 0, card: c('7S') },
      { type: 'take' },
    ]);
    expect(viewMoves(s, 'b')).toEqual(stripped(getLegalMoves(s, 'b')));
  });

  it('offers a transfer to a player with enough cards', () => {
    const s0 = makeState({
      hands: { a: '6S 9C', b: '6H 7H', c: 'JS QS' },
      deck: 'QH AD',
      attacker: 'a',
      config: { mode: 'perevodnoy' },
    });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expect(viewMoves(s, 'b')).toContainEqual({ type: 'transfer', card: c('6H') });
  });
});
