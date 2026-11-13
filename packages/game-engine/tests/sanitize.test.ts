import { describe, expect, it } from 'vitest';
import { createGame, sanitizeStateForPlayer, type GameState } from '../src/index.js';
import { c, makeState, play } from './helpers.js';

const game = (): GameState => {
  const result = createGame({ playerIds: ['p0', 'p1', 'p2'], seed: 31337 });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
};

const serialized = (card: { suit: string; rank: number }) => JSON.stringify({ suit: card.suit, rank: card.rank });

describe('sanitizeStateForPlayer', () => {
  it('shows the viewer their own hand and only counts for everyone else', () => {
    const state = game();
    const view = sanitizeStateForPlayer(state, 'p1');
    expect(view.viewerId).toBe('p1');
    expect(view.hand).toEqual(state.players[1]!.hand);
    expect(view.players).toEqual([
      { id: 'p0', handCount: 6, finished: false },
      { id: 'p1', handCount: 6, finished: false },
      { id: 'p2', handCount: 6, finished: false },
    ]);
    expect(view.deckCount).toBe(18);
    expect(view.trumpCard).toEqual(state.trumpCard);
    expect(view.trumpSuit).toBe(state.trumpCard.suit);
  });

  it('never leaks opponent cards or the stock order anywhere in the payload', () => {
    const state = game();
    const json = JSON.stringify(sanitizeStateForPlayer(state, 'p0'));
    const hidden = [...state.players[1]!.hand, ...state.players[2]!.hand, ...state.deck.slice(0, -1)];
    for (const card of hidden) expect(json).not.toContain(serialized(card));
    expect(json).not.toContain('"deck"');
    expect(json).not.toContain('"discard"');
  });

  it('does not reveal the discard pile, only its size', () => {
    const state = makeState({
      hands: { a: '6S', b: '7S 8S' },
      deck: '9D AC',
      discard: 'QH KH',
      attacker: 'a',
    });
    const json = JSON.stringify(sanitizeStateForPlayer(state, 'a'));
    expect(json).not.toContain(serialized(c('QH')));
    expect(sanitizeStateForPlayer(state, 'a').discardCount).toBe(2);
  });

  it('shows table cards and bout phase to everyone', () => {
    let state = makeState({ hands: { a: '6S 6C', b: '7S 8S 9S' }, deck: '9D AH', attacker: 'a' });
    state = play(state, { type: 'attack', playerId: 'a', card: c('6S') });
    state = play(state, { type: 'pass', playerId: 'a' });
    const view = sanitizeStateForPlayer(state, 'b');
    expect(view.table).toEqual([{ attack: c('6S'), defense: null }]);
    expect(view.phase).toEqual({ kind: 'bout', taking: false, passed: ['a'] });
    expect(view.attackerId).toBe('a');
    expect(view.defenderId).toBe('b');
  });

  it('returns a spectator view (no hand) for null or unknown viewers', () => {
    const state = game();
    for (const viewer of [null, 'intruder']) {
      const view = sanitizeStateForPlayer(state, viewer);
      expect(view.viewerId).toBeNull();
      expect(view.hand).toEqual([]);
    }
  });

  it('returns copies: mutating the view cannot corrupt the authoritative state', () => {
    const state = game();
    const before = JSON.stringify(state);
    const view = sanitizeStateForPlayer(state, 'p0');
    (view.hand as unknown as unknown[]).length = 0;
    (view.trumpCard as { rank: number }).rank = 6;
    expect(JSON.stringify(state)).toBe(before);
  });

  it('copies lastBout (public) to every viewer, spectators included', () => {
    let s = makeState({ hands: { a: '6S 9D', b: '7S KH QH', c: '8D 10H' }, deck: 'JS JD JC QS', attacker: 'a', defender: 'b' });
    expect(sanitizeStateForPlayer(s, 'a').lastBout).toBeNull();
    s = play(s, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    for (const viewer of ['a', 'b', 'c', null]) {
      const view = sanitizeStateForPlayer(s, viewer);
      expect(view.lastBout).toEqual(s.lastBout);
      expect(view.lastBout).not.toBe(s.lastBout);
    }
    const before = JSON.stringify(s);
    const view = sanitizeStateForPlayer(s, 'a');
    (view.lastBout!.table[0]!.attack as { rank: number }).rank = 14;
    expect(JSON.stringify(s)).toBe(before);
  });
});
