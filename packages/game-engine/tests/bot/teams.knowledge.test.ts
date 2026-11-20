/**
 * Team mode for the view-only bot machinery: PublicKnowledge stays sound against the real state, and
 * every sampled world is valid and re-sanitizes to exactly the bot's view (the same properties as
 * determinize.test.ts, on 2v2 games).
 */
import { cardId, type GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { playMatch } from '../../bench/match.js';
import { sampleWorld } from '../../src/bot/determinize.js';
import { GreedyBot, RandomBot, createRng, sanitizeStateForPlayer, type GameState } from '../../src/index.js';
import { checkInvariants } from '../helpers.js';

function handOf(state: GameState, id: string): readonly string[] {
  return (state.players.find((p) => p.id === id)?.hand ?? []).map(cardId);
}

describe('team mode: knowledge and determinization (property tests)', () => {
  for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
    for (let g = 0; g < 6; g++) {
      it(`${mode}, game ${g + 1}/6: knowledge is sound and sampled worlds re-sanitize to the view`, () => {
        const seed = 4242 + 17 * g + (mode === 'perevodnoy' ? 7 : 0);
        const rng = createRng(seed);
        let steps = 0;
        const result = playMatch({
          players: 4,
          mode,
          seed,
          teams: true,
          bots: Array.from({ length: 4 }, (_, i) => ((i + g) % 2 === 0 ? RandomBot : GreedyBot)),
          onStep: (state, views, knowledge) => {
            if (state.phase.kind === 'finished') return;
            steps++;
            state.players.forEach((player, seat) => {
              const view = views[seat]!;
              const k = knowledge[seat]!;
              const realDiscard = state.discard.map(cardId);
              for (const id of k.discard) expect(realDiscard).toContain(id);
              for (const [owner, cards] of Object.entries(k.knownHands)) {
                const hand = handOf(state, owner);
                for (const id of cards) if (!hand.includes(id)) expect({ owner, id, hand }).toBeNull();
              }
              if (view.players[seat]!.finished) return;
              const world = sampleWorld(view, k, createRng(rng.nextInt(1 << 30)));
              if (!world.ok) throw new Error(`${player.id}: ${world.error.message}`);
              expect(world.value.config.teams).toBe(true);
              checkInvariants(world.value);
              const resanitized = sanitizeStateForPlayer(world.value, player.id);
              if (JSON.stringify(resanitized) !== JSON.stringify(view)) expect(resanitized).toEqual(view);
            });
          },
        });
        expect(result.abandoned).toBe(false);
        expect(steps).toBeGreaterThan(0);
      }, 60_000);
    }
  }
});
