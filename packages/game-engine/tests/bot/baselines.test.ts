import { describe, expect, it } from 'vitest';
import { GreedyBot, RandomBot, createRng, getLegalMovesForView, initKnowledge, moveKey, pickGreedy, sanitizeStateForPlayer } from '../../src/index.js';
import { c, makeState, play } from '../helpers.js';

describe('greedy heuristic', () => {
  const state = makeState({
    hands: { p0: '7S 9D 6H QS', p1: '8S 10S 7H JD KD' },
    deck: '6C 6D 8H',
    trump: '8H',
  });
  const choose = (s: typeof state, id: string) => {
    const view = sanitizeStateForPlayer(s, id);
    return GreedyBot.choose(view, initKnowledge(view), createRng(1));
  };

  it('opens with the cheapest non-trump', () => {
    expect(choose(state, 'p0')).toEqual({ type: 'attack', card: c('7S') });
  });

  it('defends with the cheapest beating card', () => {
    const s = play(state, { type: 'attack', playerId: 'p0', card: c('7S') });
    expect(choose(s, 'p1')).toEqual({ type: 'defend', attackIndex: 0, card: c('8S') });
  });

  it('defends with a trump when only a trump beats the card', () => {
    const s = play(state, { type: 'attack', playerId: 'p0', card: c('QS') });
    expect(choose(s, 'p1')).toEqual({ type: 'defend', attackIndex: 0, card: c('7H') });
  });

  it('takes when some uncovered attack card cannot be beaten', () => {
    const table = [
      { attack: c('QS'), defense: null },
      { attack: c('9D'), defense: null },
    ];
    const legal = [{ type: 'defend', attackIndex: 0, card: c('KS') }, { type: 'take' }] as const;
    expect(pickGreedy(legal, { trumpSuit: 'H', table })).toEqual({ type: 'take' });
  });

  it('throws in a matching non-trump, never a trump; otherwise passes', () => {
    let s = makeState({ hands: { p0: '7S 7D 7H QS', p1: '8S 9S 10D JD KD' }, deck: '6C 6D 8H', trump: '8H' });
    s = play(s, { type: 'attack', playerId: 'p0', card: c('7S') });
    s = play(s, { type: 'defend', playerId: 'p1', attackIndex: 0, card: c('8S') });
    expect(choose(s, 'p0')).toEqual({ type: 'attack', card: c('7D') });
    s = play(s, { type: 'attack', playerId: 'p0', card: c('7D') });
    s = play(s, { type: 'defend', playerId: 'p1', attackIndex: 1, card: c('10D') });
    expect(choose(s, 'p0')).toEqual({ type: 'pass' }); // only the trump 7H matches
  });
});

describe('random bot', () => {
  it('always picks a legal move', () => {
    const state = makeState({ hands: { p0: '7S 9D 6H QS', p1: '8S 10S 7H JD KD' }, deck: '6C 6D 8H', trump: '8H' });
    const view = sanitizeStateForPlayer(state, 'p0');
    const legal = getLegalMovesForView(view).map(moveKey);
    const rng = createRng(4);
    for (let i = 0; i < 20; i++) expect(legal).toContain(moveKey(RandomBot.choose(view, initKnowledge(view), rng)!));
  });
});
