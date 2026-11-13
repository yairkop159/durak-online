import { getLegalMovesForView } from '@durak/game-engine';
import type { Card, ClientMove, PlayerView } from '@durak/shared';

/** Orders cards cheapest-first: non-trumps by rank, then trumps by rank. */
function cost(card: Card, view: PlayerView): number {
  return card.rank + (card.suit === view.trumpSuit ? 100 : 0);
}

type MoveOf<T extends ClientMove['type']> = Extract<ClientMove, { type: T }>;

function ofType<T extends ClientMove['type']>(moves: readonly ClientMove[], type: T): MoveOf<T>[] {
  return moves.filter((m): m is MoveOf<T> => m.type === type);
}

function cheapest<M extends { card: Card }>(moves: readonly M[], view: PlayerView): M | undefined {
  return [...moves].sort((a, b) => cost(a.card, view) - cost(b.card, view))[0];
}

/**
 * A simple, always-legal policy computed ONLY from what the server sends a player:
 * open with the cheapest card; defend the first uncovered card as cheaply as possible, else take;
 * throw in the cheapest non-trump, else pass. Returns null when the player has nothing to do.
 */
export function chooseMove(view: PlayerView): ClientMove | null {
  const moves = getLegalMovesForView(view);
  if (moves.length === 0) return null;

  if (view.phase.kind === 'awaitingAttack') {
    return cheapest(ofType(moves, 'attack'), view) ?? null;
  }

  if (view.defenderId === view.viewerId) {
    const firstUncovered = view.table.findIndex((p) => p.defense === null);
    const defend = cheapest(
      ofType(moves, 'defend').filter((m) => m.attackIndex === firstUncovered),
      view,
    );
    return defend ?? moves.find((m) => m.type === 'take') ?? null;
  }

  const throwIn = cheapest(
    ofType(moves, 'attack').filter((m) => m.card.suit !== view.trumpSuit),
    view,
  );
  return throwIn ?? moves.find((m) => m.type === 'pass') ?? null;
}
