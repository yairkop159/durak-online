import type { GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { playMatch } from '../../bench/match.js';
import { GreedyBot, RandomBot, createIsmctsBot, type Bot } from '../../src/index.js';

/** Every bot plays every seat; `playMatch` rejects any move that fails `validateMove` on the real state. */
describe('bots never play an illegal move', () => {
  const ismcts = createIsmctsBot({ budget: () => ({ iterations: 30 }) });
  const roster: Bot[] = [ismcts, GreedyBot, RandomBot];
  for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
    for (const players of [2, 3, 4, 5, 6]) {
      // One test per game (3 rotations of the roster): short synchronous blocks, see tests/setup/eventLoop.ts.
      for (let g = 0; g < 3; g++) {
        it(`${players} players, ${mode}, rotation ${g + 1}/3`, () => {
          const bots = Array.from({ length: players }, (_, seat) => roster[(seat + g) % roster.length]!);
          const result = playMatch({ players, mode, seed: 500 + 31 * players + g, bots });
          expect(result.abandoned).toBe(false);
          expect(result.final.phase.kind).toBe('finished');
        }, 60_000);
      }
    }
  }
});
