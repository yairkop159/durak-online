import { cardId, type GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { playMatch } from '../../bench/match.js';
import { sampleWorld } from '../../src/bot/determinize.js';
import {
  GreedyBot,
  RandomBot,
  chooseBotMove,
  createGame,
  createRng,
  getLegalMovesForView,
  initKnowledge,
  sanitizeStateForPlayer,
  type GameState,
  type PlayerState,
} from '../../src/index.js';
import { moveKey } from '../../src/bot/moveKey.js';
import { checkInvariants } from '../helpers.js';

function handOf(state: GameState, id: string): readonly string[] {
  return (state.players.find((p: PlayerState) => p.id === id)?.hand ?? []).map(cardId);
}

describe('determinization (property tests)', () => {
  for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
    for (const players of [2, 3, 4, 5, 6]) {
      // One test per game (4 games per case): short synchronous blocks, see tests/setup/eventLoop.ts.
      for (let g = 0; g < 4; g++) {
        it(`${players} players, ${mode}, game ${g + 1}/4: every sampled world is valid, re-sanitizes to the view, and knowledge is sound`, () => {
          const seed = 1000 * players + 17 * g + (mode === 'perevodnoy' ? 7 : 0);
          const rng = createRng(seed);
          let steps = 0;
          playMatch({
            players,
            mode,
            seed,
            bots: Array.from({ length: players }, (_, i) => ((i + g) % 2 === 0 ? RandomBot : GreedyBot)),
            onStep: (state, views, knowledge) => {
              if (state.phase.kind === 'finished') return;
              steps++;
              state.players.forEach((player, seat) => {
                const view = views[seat]!;
                const k = knowledge[seat]!;
                // Soundness: the real state agrees with everything the knowledge claims.
                const realDiscard = state.discard.map(cardId);
                for (const id of k.discard) expect(realDiscard).toContain(id);
                for (const [owner, cards] of Object.entries(k.knownHands)) {
                  const hand = handOf(state, owner);
                  for (const id of cards) if (!hand.includes(id)) expect({ owner, id, hand }).toBeNull();
                }
                if (view.players[seat]!.finished) return;

                const sample = rng.nextInt(1 << 30);
                const world = sampleWorld(view, k, createRng(sample));
                if (!world.ok) throw new Error(`${player.id}: ${world.error.message}`);
                checkInvariants(world.value);
                const resanitized = sanitizeStateForPlayer(world.value, player.id);
                if (JSON.stringify(resanitized) !== JSON.stringify(view)) expect(resanitized).toEqual(view);
                const again = sampleWorld(view, k, createRng(sample));
                if (!again.ok || JSON.stringify(again.value) !== JSON.stringify(world.value)) {
                  expect(again).toEqual(world);
                }
              });
            },
          });
          expect(steps).toBeGreaterThan(0);
        }, 60_000);
      }
    }
  }

  it('different seeds give different worlds (the hidden cards really are resampled)', () => {
    const created = createGame({ playerIds: ['a', 'b', 'c'], seed: 5 });
    if (!created.ok) throw new Error('setup');
    const view = sanitizeStateForPlayer(created.value, 'a');
    const k = initKnowledge(view);
    const worlds = new Set<string>();
    for (let s = 0; s < 10; s++) {
      const w = sampleWorld(view, k, createRng(s));
      if (w.ok) worlds.add(JSON.stringify(w.value.players));
    }
    expect(worlds.size).toBeGreaterThan(1);
  });

  it('inconsistent knowledge is rejected, and the bot falls back to what the view alone proves', () => {
    const created = createGame({ playerIds: ['a', 'b'], seed: 9 });
    if (!created.ok) throw new Error('setup');
    const me = created.value.players[created.value.attackerIndex]!.id;
    const other = me === 'a' ? 'b' : 'a';
    const view = sanitizeStateForPlayer(created.value, me);
    // Claims the opponent holds the viewer's own cards, and more cards than they have: impossible.
    const bogus = { viewerId: me, discard: [], knownHands: { [other]: [...view.hand.map(cardId), 'AS', 'AC'] } };
    expect(sampleWorld(view, bogus, createRng(1)).ok).toBe(false);
    const move = chooseBotMove(view, bogus, { seed: 3, budget: { iterations: 20 } });
    expect(move).not.toBeNull();
    expect(getLegalMovesForView(view).map(moveKey)).toContain(moveKey(move!));
  });
});
