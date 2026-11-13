import type { ClientMove, PlayerView } from '@durak/shared';
import type { Rng } from '../rng.js';
import { getLegalMovesForView } from '../viewMoves.js';
import { pickGreedy } from './greedy.js';
import type { PublicKnowledge } from './knowledge.js';

/** A bot sees exactly what a human player sees: their view plus public knowledge. */
export interface Bot {
  readonly name: string;
  choose(view: PlayerView, knowledge: PublicKnowledge, rng: Rng): ClientMove | null;
}

/** Uniformly random legal move. */
export const RandomBot: Bot = {
  name: 'random',
  choose(view, _knowledge, rng) {
    const legal = getLegalMovesForView(view);
    return legal.length === 0 ? null : legal[rng.nextInt(legal.length)]!;
  },
};

/** The greedy heuristic (`pickGreedy`), the same policy IS-MCTS uses for rollouts. */
export const GreedyBot: Bot = {
  name: 'greedy',
  choose(view) {
    return pickGreedy(getLegalMovesForView(view), { trumpSuit: view.trumpSuit, table: view.table });
  },
};
