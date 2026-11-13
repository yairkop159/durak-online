import type { ClientMove, PlayerView } from '@durak/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { chooseBotMove, type BotOptions, type PublicKnowledge } from '../../src/index.js';

/**
 * The bot must be unable to cheat by construction. Its public API takes only what a human player
 * gets, and only the simulation files (which build determinized worlds) may touch the engine's
 * GameState internals. Nothing in the bot may turn a real state into a view (sanitize) or create a
 * game from a real deck.
 */
const BOT_DIR = fileURLToPath(new URL('../../src/bot/', import.meta.url));

/** Files that only ever see views. */
const VIEW_ONLY = new Set(['knowledge.ts', 'greedy.ts', 'baselines.ts', 'moveKey.ts']);
/** Files that simulate determinized worlds. */
const SIMULATION = new Set(['determinize.ts', 'ismcts.ts', 'turnOrder.ts', 'rewards.ts']);
const BARREL = 'index.ts';

const VIEW_SAFE_ENGINE = new Set(['../viewMoves.js', '../viewInference.js', '../rng.js', '../deck.js', '../result.js']);
const SIMULATION_ENGINE = new Set([...VIEW_SAFE_ENGINE, '../state.js', '../rules.js']);

function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

describe('no cheating, by construction', () => {
  const files = readdirSync(BOT_DIR).filter((f) => f.endsWith('.ts'));

  it('every bot file is classified', () => {
    for (const f of files) expect(VIEW_ONLY.has(f) || SIMULATION.has(f) || f === BARREL, f).toBe(true);
  });

  for (const file of files) {
    it(`${file} imports only what its role allows`, () => {
      const source = readFileSync(BOT_DIR + file, 'utf8');
      for (const spec of importsOf(source)) {
        if (spec === '@durak/shared') continue;
        if (spec.startsWith('./')) {
          const sibling = spec.slice(2).replace(/\.js$/, '.ts');
          // A view-only file may never reach a simulation file (and through it, GameState).
          if (VIEW_ONLY.has(file)) expect(VIEW_ONLY.has(sibling), `${file} -> ${spec}`).toBe(true);
          continue;
        }
        const allowed = VIEW_ONLY.has(file) || file === BARREL ? VIEW_SAFE_ENGINE : SIMULATION_ENGINE;
        expect(allowed.has(spec), `${file} must not import ${spec}`).toBe(true);
      }
      // Never project a real state onto a view, never create a game from a real deck.
      expect(source).not.toMatch(/sanitizeStateForPlayer|createGame|createGameWithDeck/);
      // Only the determinizer assembles a GameState (every GameState literal has a `deck` field).
      if (file !== 'determinize.ts') expect(source).not.toMatch(/\bdeck\s*[:,]\s*\S/);
    });
  }

  it('the public API takes a view, public knowledge and options, nothing else', () => {
    expectTypeOf(chooseBotMove).parameters.toEqualTypeOf<[PlayerView, PublicKnowledge, BotOptions]>();
    expectTypeOf(chooseBotMove).returns.toEqualTypeOf<ClientMove | null>();
  });
});
