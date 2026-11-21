import { isTeamGame, teamOfSeat, type Card, type Suit } from '@durak/shared';
import type { GameState } from '../state.js';

/**
 * Per-seat reward vectors in [0, 1] (index = seat).
 *
 * Terminal: the durak gets 0, everyone else 1. A draw (`durak === null`: the last players went out
 * together) gives 0.5 to each player of that last group (`before` = the state before the final move);
 * players who went out earlier keep 1.
 *
 * Team mode (2v2): every player gets their team's result (the durak's team 0, the other team 1, a
 * draw 0.5), so IS-MCTS (each node maximizes the reward of the seat that moved into it) plays for
 * the team with no other change.
 */
export function terminalRewards(final: GameState, before: GameState): number[] {
  if (final.phase.kind !== 'finished') throw new Error('terminalRewards needs a finished state');
  const durak = final.phase.durak;
  if (isTeamGame(final.config)) {
    // Teams: both partners share the team's outcome (the durak's team 0, the other 1; a draw 0.5).
    const losing = durak === null ? null : teamOfSeat(final.players.findIndex((p) => p.id === durak));
    return final.players.map((_, seat) => (losing === null ? 0.5 : teamOfSeat(seat) === losing ? 0 : 1));
  }
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
 * hand by how hard it is to get rid of. A rough proxy for "not being the durak". Team mode: both
 * partners get 1 - their team's summed badness / total (the two team values add up to 1).
 */
export function cutoffRewards(state: GameState): number[] {
  const trump = state.trumpCard.suit;
  const badness = state.players.map((p) =>
    state.finishOrder.includes(p.id) ? 0 : p.hand.reduce((sum, c) => sum + cardBadness(c, trump), 0),
  );
  const total = badness.reduce((a, b) => a + b, 0);
  if (isTeamGame(state.config)) {
    // Teams: a team's badness is the sum over its players; both partners get the team's value.
    const teamBadness = [0, 0];
    badness.forEach((b, seat) => (teamBadness[teamOfSeat(seat)]! += b));
    return state.players.map((_, seat) => (total === 0 ? 0.5 : 1 - teamBadness[teamOfSeat(seat)]! / total));
  }
  return state.players.map((p, i) => {
    if (state.finishOrder.includes(p.id)) return 1;
    return total === 0 ? 0.5 : 1 - badness[i]! / total;
  });
}
