import { beats } from '@durak/game-engine';
import type { Card, ClientMove, PlayerView } from '@durak/shared';

/** Orders cards cheapest-first: non-trumps by rank, then trumps by rank. */
function cost(card: Card, view: PlayerView): number {
  return card.rank + (card.suit === view.trumpSuit ? 100 : 0);
}

function cheapest(cards: readonly Card[], view: PlayerView): Card | undefined {
  return [...cards].sort((a, b) => cost(a, view) - cost(b, view))[0];
}

/**
 * A simple, always-legal policy computed ONLY from what the server sends a player.
 * Returns null when the player has nothing to do.
 */
export function chooseMove(view: PlayerView): ClientMove | null {
  const me = view.viewerId;
  if (me === null || view.phase.kind === 'finished') return null;
  if (view.players.find((p) => p.id === me)?.finished) return null;

  if (view.phase.kind === 'awaitingAttack') {
    if (view.attackerId !== me) return null;
    const card = cheapest(view.hand, view);
    return card ? { type: 'attack', card } : null;
  }

  const phase = view.phase;
  if (view.defenderId === me) {
    if (phase.taking) return null;
    const index = view.table.findIndex((p) => p.defense === null);
    if (index === -1) return null;
    const attack = view.table[index]!.attack;
    const card = cheapest(
      view.hand.filter((c) => beats(attack, c, view.trumpSuit)),
      view,
    );
    return card ? { type: 'defend', attackIndex: index, card } : { type: 'take' };
  }

  if (phase.passed.includes(me)) return null;
  const limit = view.boutNumber === 1 ? view.config.firstBoutMaxCards : view.config.boutMaxCards;
  const uncovered = view.table.filter((p) => p.defense === null).length;
  const defenderCards = view.players.find((p) => p.id === view.defenderId)?.handCount ?? 0;
  if (view.table.length < limit && uncovered < defenderCards) {
    const ranks = new Set(view.table.flatMap((p) => (p.defense ? [p.attack.rank, p.defense.rank] : [p.attack.rank])));
    const card = cheapest(
      view.hand.filter((c) => ranks.has(c.rank) && c.suit !== view.trumpSuit),
      view,
    );
    if (card) return { type: 'attack', card };
  }
  return { type: 'pass' };
}
