/**
 * Hidden information in team mode: a player never sees their partner's hand (or the stock order).
 * Partners get exactly what opponents get: a hand count.
 */
import { cardId, partnerOf, type Card, type PlayerView } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { sanitizeStateForPlayer, type GameState } from '../src/index.js';
import { playRandomGame } from './selfPlay.js';

/** Every card object anywhere in the view, except in the two public places a partner's card may show. */
function cardsOutsidePublicHistory(view: PlayerView): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    if (typeof o.suit === 'string' && typeof o.rank === 'number') found.add(cardId(o as unknown as Card));
    for (const child of Object.values(o)) walk(child);
  };
  // Allowed: `lastBout` (after a take its public cards are in the taker's hand) and the face-up trump.
  walk({ ...view, lastBout: null, trumpCard: null });
  return found;
}

function checkPartnerHidden(state: GameState): void {
  for (const player of state.players) {
    const view = sanitizeStateForPlayer(state, player.id);
    const partner = partnerOf(state.config, state.players, player.id)!;
    const partnerHand = state.players.find((p) => p.id === partner)!.hand.map(cardId);
    const seen = cardsOutsidePublicHistory(view);
    // A partner's card never appears in my view (only their hand count does).
    for (const id of partnerHand) {
      if (seen.has(id)) expect({ viewer: player.id, partnerCard: id }).toBeNull();
    }
    // The partner entry carries exactly what an opponent's does.
    for (const p of view.players) expect(Object.keys(p).sort()).toEqual(['finished', 'handCount', 'id']);
    expect(view.players.find((p) => p.id === partner)!.handCount).toBe(partnerHand.length);
    // No hidden-card field anywhere (deck order, discard, other hands).
    const json = JSON.stringify(view);
    for (const key of ['"deck"', '"discard"', '"hands"']) expect(json).not.toContain(key);
    expect(view.hand.map(cardId)).toEqual(player.hand.map(cardId));
  }
}

describe('sanitize in team mode', () => {
  it("never reveals the partner's hand, on any step of 20 games per mode", () => {
    for (const mode of ['podkidnoy', 'perevodnoy'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        playRandomGame(4, mode, seed * 389 + 4, {
          teams: true,
          onStep: (_before, _move, after) => checkPartnerHidden(after),
        });
      }
    }
  }, 60_000);

  it('the team flag is the only difference from a non-team view of the same state', () => {
    const final = playRandomGame(4, 'podkidnoy', 77, { teams: true });
    const { teams: _teams, ...classicConfig } = final.config;
    for (const p of final.players) {
      const teamView = sanitizeStateForPlayer(final, p.id);
      const classicView = sanitizeStateForPlayer({ ...final, config: classicConfig }, p.id);
      expect({ ...teamView, config: classicConfig }).toEqual(classicView);
      expect(teamView.config.teams).toBe(true);
    }
  });
});
