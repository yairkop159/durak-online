import type { Card, ClientMove, PlayerView, TablePair } from '@durak/shared';
import { beats } from './deck.js';

/**
 * Every legal move for the viewer, computed ONLY from their sanitized view (no hidden information).
 * Mirrors `getLegalMoves(state, viewerId)` exactly, without the `playerId` (a property test in
 * `tests/fuzz.test.ts` checks the two agree on every reachable state). Same candidate order.
 * Returns `[]` for a spectator view, a finished game, or a viewer who is already out.
 */
export function getLegalMovesForView(view: PlayerView): ClientMove[] {
  const me = view.viewerId;
  const phase = view.phase;
  if (me === null || phase.kind === 'finished') return [];
  const seat = view.players.findIndex((p) => p.id === me);
  if (seat === -1 || view.players[seat]?.finished) return [];

  const hand = view.hand;
  if (phase.kind === 'awaitingAttack') {
    return view.attackerId === me ? hand.map((card) => ({ type: 'attack', card })) : [];
  }

  const moves: ClientMove[] = [];
  const table = view.table;
  const limit = view.boutNumber === 1 ? view.config.firstBoutMaxCards : view.config.boutMaxCards;
  const uncovered = table.filter((p) => p.defense === null).length;

  if (view.defenderId !== me) {
    const defenderCards = view.players.find((p) => p.id === view.defenderId)?.handCount ?? 0;
    if (table.length < limit && uncovered < defenderCards) {
      const ranks = tableRanks(table);
      for (const card of hand) if (ranks.has(card.rank)) moves.push({ type: 'attack', card });
    }
    if (!phase.passed.includes(me)) moves.push({ type: 'pass' });
    return moves;
  }

  if (phase.taking) return moves;
  table.forEach((pair, attackIndex) => {
    if (pair.defense !== null) return;
    for (const card of hand) {
      if (beats(pair.attack, card, view.trumpSuit)) moves.push({ type: 'defend', attackIndex, card });
    }
  });
  for (const card of hand) if (canTransfer(view, seat, card, limit)) moves.push({ type: 'transfer', card });
  if (uncovered > 0) moves.push({ type: 'take' });
  return moves;
}

function tableRanks(table: readonly TablePair[]): Set<number> {
  const ranks = new Set<number>();
  for (const pair of table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

function canTransfer(view: PlayerView, seat: number, card: Card, limit: number): boolean {
  if (view.config.mode !== 'perevodnoy') return false;
  if (view.table.some((p) => p.defense !== null || p.attack.rank !== card.rank)) return false;
  const next = nextActiveSeat(view, seat);
  if (next === seat) return false;
  const newCount = view.table.length + 1;
  return newCount <= limit && newCount <= (view.players[next]?.handCount ?? 0);
}

function nextActiveSeat(view: PlayerView, from: number): number {
  const n = view.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!view.players[idx]?.finished) return idx;
  }
  return from;
}
