/**
 * Bots in 2v2 team mode: rewards are per team (so IS-MCTS plays for the team), and every bot plays
 * only legal moves in every seat. The bots still get only a view + PublicKnowledge (playMatch).
 */
import type { GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { playMatch } from '../../bench/match.js';
import { cutoffRewards, terminalRewards } from '../../src/bot/rewards.js';
import { GreedyBot, RandomBot, createIsmctsBot, type Bot, type GameState } from '../../src/index.js';
import { makeState } from '../helpers.js';

const TEAMS = { teams: true } as const;

describe('team rewards', () => {
  const base = makeState({ hands: { a: '7S', b: '', c: '8S 9S', d: '' }, finishOrder: ['b', 'd'], config: TEAMS });

  it("both partners share the team's result: the durak's team 0, the other team 1", () => {
    const final: GameState = { ...base, phase: { kind: 'finished', durak: 'c' } };
    expect(terminalRewards(final, base)).toEqual([0, 1, 0, 1]);
    const other: GameState = { ...base, phase: { kind: 'finished', durak: 'd' } };
    expect(terminalRewards(other, base)).toEqual([1, 0, 1, 0]);
  });

  it('a draw gives everyone 0.5', () => {
    const final: GameState = { ...base, finishOrder: ['b', 'd', 'a', 'c'], phase: { kind: 'finished', durak: null } };
    expect(terminalRewards(final, base)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("cutoff: partners get the same value and the two teams' values add up to 1", () => {
    const state = makeState({ hands: { a: '6S 7S', b: 'AH', c: '8S', d: 'KH QH' }, trump: '6H', config: TEAMS });
    const r = cutoffRewards(state);
    expect(r[0]).toBe(r[2]);
    expect(r[1]).toBe(r[3]);
    expect(r[0]! + r[1]!).toBeCloseTo(1);
    expect(r[0]!).toBeLessThan(r[1]!); // team 0 holds more, weaker cards
    // A player who is out still counts for the team (no free 1 for going out alone).
    const out = makeState({ hands: { a: '', b: 'AH', c: '6S 7S 8S', d: 'KH' }, finishOrder: ['a'], trump: '6H', config: TEAMS });
    const r2 = cutoffRewards(out);
    expect(r2[0]).toBe(r2[2]);
    expect(r2[0]!).toBeLessThan(0.5);
  });

  it('non-team rewards are unchanged', () => {
    const classic = makeState({ hands: { a: '', b: '6S 7S 8S', c: 'AH' }, finishOrder: ['a'], trump: '6H' });
    const r = cutoffRewards(classic);
    expect(r[0]).toBe(1);
    expect(r[1]! + r[2]!).toBeCloseTo(1);
  });
});

describe('bots never play an illegal move in team games', () => {
  const ismcts = createIsmctsBot({ budget: () => ({ iterations: 30 }) });
  const roster: Bot[] = [ismcts, GreedyBot, RandomBot];
  for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
    for (let g = 0; g < 4; g++) {
      it(`${mode}, rotation ${g + 1}/4`, () => {
        const bots = Array.from({ length: 4 }, (_, seat) => roster[(seat + g) % roster.length]!);
        const result = playMatch({ players: 4, mode, seed: 900 + 13 * g, teams: true, bots });
        expect(result.abandoned).toBe(false);
        expect(result.final.phase.kind).toBe('finished');
      }, 60_000);
    }
  }
});
