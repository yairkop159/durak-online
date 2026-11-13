import type { Card, Suit } from '@durak/shared';
import type { GameState } from '../state.js';

/**
 * Per-seat reward vectors in [0, 1] (index = seat).
 *
 * Terminal: the durak gets 0, everyone else 1. A draw (`durak === null`: the last players went out
 * together) gives 0.5 to each player of that last group (`before` = the state before the final move);
 * players who went out earlier keep 1.
 */
export function terminalRewards(final: GameState, before: GameState): number[] {
  if (final.phase.kind !== 'finished') throw new Error('terminalRewards needs a finished state');
  const durak = final.phase.durak;
  return final.players.map((p) => {
    if (durak !== null) return p.id === durak ? 0 : 1;
    return before.finishOrder.includes(p.id) ? 1 : 0.5;
  });
}

/** How much a card in hand hurts: low non-trumps the most, trumps the least. */
function cardBadness(card: Card, trump: Suit): number {
  return card.suit === trump ? 0.5 : 1.5 - (card.rank - 6) / 8;
}

/**
 * Heuristic rewards when a rollout hits its depth limit. Players already out get 1; each active
 * player gets 1 - badness / total badness of the active players, where badness weighs each card in
 * hand by how hard it is to get rid of. A rough proxy for "not being the durak".
 */
export function cutoffRewards(state: GameState): number[] {
  const trump = state.trumpCard.suit;
  const badness = state.players.map((p) =>
    state.finishOrder.includes(p.id) ? 0 : p.hand.reduce((sum, c) => sum + cardBadness(c, trump), 0),
  );
  const total = badness.reduce((a, b) => a + b, 0);
  return state.players.map((p, i) => {
    if (state.finishOrder.includes(p.id)) return 1;
    return total === 0 ? 0.5 : 1 - badness[i]! / total;
  });
}
