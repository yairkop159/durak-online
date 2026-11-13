import type { Card, ClientMove, Suit, TablePair } from '@durak/shared';

/** How much a card is "worth keeping": non-trumps by rank, every trump above every non-trump. */
export function cardCost(card: Card, trump: Suit): number {
  return (card.suit === trump ? 100 : 0) + card.rank;
}

export interface GreedyContext {
  readonly trumpSuit: Suit;
  readonly table: readonly TablePair[];
}

/**
 * The fast greedy heuristic, choosing among moves that are already known to be legal for one player
 * (so it can never pick an illegal move). Used by `GreedyBot` and as the IS-MCTS rollout policy.
 * - Defender: if every uncovered attack card can be beaten, the cheapest defense; otherwise take.
 *   Never transfers.
 * - Opening attack: the cheapest card.
 * - Throw-in: the cheapest non-trump; otherwise pass.
 * - Anything else: the first legal move.
 */
export function pickGreedy<M extends ClientMove>(legal: readonly M[], ctx: GreedyContext): M | null {
  if (legal.length === 0) return null;
  const cost = (card: Card): number => cardCost(card, ctx.trumpSuit);

  let take: M | undefined;
  let pass: M | undefined;
  let bestDefend: M | undefined;
  let bestDefendCost = Infinity;
  let bestAttack: M | undefined;
  let bestAttackCost = Infinity;
  const beatable = new Set<number>();
  for (const move of legal) {
    switch (move.type) {
      case 'take':
        take = move;
        break;
      case 'pass':
        pass = move;
        break;
      case 'defend': {
        beatable.add(move.attackIndex);
        const c = cost(move.card);
        if (c < bestDefendCost) {
          bestDefendCost = c;
          bestDefend = move;
        }
        break;
      }
      case 'attack': {
        const c = cost(move.card);
        if (c < bestAttackCost) {
          bestAttackCost = c;
          bestAttack = move;
        }
        break;
      }
      case 'transfer':
        break;
    }
  }

  if (bestDefend !== undefined || take !== undefined) {
    let uncovered = 0;
    let allBeatable = true;
    ctx.table.forEach((pair, i) => {
      if (pair.defense !== null) return;
      uncovered++;
      if (!beatable.has(i)) allBeatable = false;
    });
    if (bestDefend !== undefined && (allBeatable || take === undefined) && uncovered > 0) return bestDefend;
    if (take !== undefined) return take;
  }

  if (bestAttack !== undefined) {
    if (ctx.table.length === 0) return bestAttack; // opening
    if (bestAttack.type === 'attack' && bestAttack.card.suit !== ctx.trumpSuit) return bestAttack;
    if (pass !== undefined) return pass;
    return bestAttack;
  }
  return pass ?? legal[0]!;
}
