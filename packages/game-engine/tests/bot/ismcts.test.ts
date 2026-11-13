import { sameCard, type Card } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { searchBotMove } from '../../src/bot/ismcts.js';
import { cutoffRewards, terminalRewards } from '../../src/bot/rewards.js';
import { canonicalActor } from '../../src/bot/turnOrder.js';
import { chooseBotMove, createDeck, createGame, initKnowledge, sanitizeStateForPlayer, type GameState } from '../../src/index.js';
import { c, cards, makeState, play } from '../helpers.js';

/** A position that conserves all 36 cards: everything not in a hand, the stock or on the table is discarded. */
function endgame(hands: Record<string, string>, trump: string): GameState {
  const used = Object.values(hands).flatMap(cards);
  const discard = createDeck().filter((x) => !used.some((u: Card) => sameCard(u, x)));
  return { ...makeState({ hands, trump }), discard };
}

const search = (state: GameState, viewer: string, iterations: number, seed = 1) => {
  const view = sanitizeStateForPlayer(state, viewer);
  return searchBotMove(view, initKnowledge(view), { seed, budget: { iterations } });
};

describe('IS-MCTS bot', () => {
  it('returns the only legal move without searching', () => {
    const state = endgame({ p0: '7S', p1: '8S 9S' }, '6H');
    const result = search(state, 'p0', 500);
    expect(result.move).toEqual({ type: 'attack', card: c('7S') });
    expect(result.iterations).toBe(0);
  });

  it('takes when nothing in hand beats the attack (forced take)', () => {
    let state = endgame({ p0: '10S JS QS', p1: '6S 7D 8C' }, '6H');
    state = play(state, { type: 'attack', playerId: 'p0', card: c('10S') });
    expect(search(state, 'p1', 200).move).toEqual({ type: 'take' });
  });

  it('finds the winning last card in a hidden-information endgame', () => {
    // Stock empty, trumps are hearts. Opening the ace of trumps wins whatever the opponent holds
    // (they must take it, then p0's 6S goes out); opening 6S loses to almost any card.
    const state = endgame({ p0: 'AH 6S', p1: '7S' }, '6H');
    const result = search(state, 'p0', 400);
    expect(result.move).toEqual({ type: 'attack', card: c('AH') });
  });

  it('is deterministic for a fixed seed', () => {
    const created = createGame({ playerIds: ['a', 'b', 'c'], seed: 42 });
    if (!created.ok) throw new Error('setup');
    const one = search(created.value, created.value.players[created.value.attackerIndex]!.id, 150, 7);
    const two = search(created.value, created.value.players[created.value.attackerIndex]!.id, 150, 7);
    expect(one).toEqual(two);
    expect(one.root.length).toBeGreaterThan(1);
  });

  it('runs exactly the requested number of iterations', () => {
    const created = createGame({ playerIds: ['a', 'b'], seed: 3 });
    if (!created.ok) throw new Error('setup');
    const attacker = created.value.players[created.value.attackerIndex]!.id;
    expect(search(created.value, attacker, 37).iterations).toBe(37);
  });

  it('respects a deadline on the injected clock', () => {
    const created = createGame({ playerIds: ['a', 'b'], seed: 3 });
    if (!created.ok) throw new Error('setup');
    const attacker = created.value.players[created.value.attackerIndex]!.id;
    const view = sanitizeStateForPlayer(created.value, attacker);
    let t = 0;
    const now = () => ++t;
    const result = searchBotMove(view, initKnowledge(view), { seed: 1, budget: { deadlineMs: 50, now } });
    expect(result.iterations).toBe(50);
    expect(chooseBotMove(view, initKnowledge(view), { seed: 1, budget: { deadlineMs: 0, now: () => 0 } })).not.toBeNull();
  });
});

describe('canonical player to move', () => {
  it('attacker opens, defender answers, then throw-ins clockwise from the main attacker', () => {
    let state = makeState({
      hands: { p0: '7S 7D', p1: '9S 10D QS', p2: '7C 8C' },
      deck: '6C 6D 6H',
      trump: '6H',
    });
    expect(canonicalActor(state)).toBe(0);
    state = play(state, { type: 'attack', playerId: 'p0', card: c('7S') });
    expect(canonicalActor(state)).toBe(1);
    state = play(state, { type: 'defend', playerId: 'p1', attackIndex: 0, card: c('9S') });
    expect(canonicalActor(state)).toBe(0); // p0 can throw in 7D
    state = play(state, { type: 'pass', playerId: 'p0' });
    expect(canonicalActor(state)).toBe(2); // p2 can throw in 7C
    state = play(state, { type: 'attack', playerId: 'p2', card: c('7C') });
    expect(canonicalActor(state)).toBe(1); // a new uncovered card: the defender again
    state = play(state, { type: 'take', playerId: 'p1' });
    expect(canonicalActor(state)).toBe(0); // passes were reset: p0 may throw in 7D
  });

  it('is -1 when the game is over', () => {
    const state = makeState({ hands: { p0: '', p1: '7S' }, phase: { kind: 'finished', durak: 'p1' } });
    expect(canonicalActor(state)).toBe(-1);
  });
});

describe('rewards', () => {
  const base = makeState({ hands: { a: '', b: '', c: '7S' }, finishOrder: ['a'] });
  it('durak 0, everyone else 1', () => {
    const final: GameState = { ...base, finishOrder: ['a', 'b'], phase: { kind: 'finished', durak: 'c' } };
    expect(terminalRewards(final, base)).toEqual([1, 1, 0]);
  });
  it('a draw gives 0.5 to the players who went out together, 1 to earlier finishers', () => {
    const final: GameState = { ...base, finishOrder: ['a', 'b', 'c'], phase: { kind: 'finished', durak: null } };
    expect(terminalRewards(final, base)).toEqual([1, 0.5, 0.5]);
  });
  it('cutoff: finished players 1, more and weaker cards = lower reward', () => {
    const state = makeState({ hands: { a: '', b: '6S 7S 8S', c: 'AH' }, finishOrder: ['a'], trump: '6H' });
    const r = cutoffRewards(state);
    expect(r[0]).toBe(1);
    expect(r[1]!).toBeLessThan(r[2]!);
    for (const x of r) expect(x).toBeGreaterThanOrEqual(0);
  });
});
