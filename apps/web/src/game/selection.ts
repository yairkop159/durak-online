import { sameCard, type Card, type ClientMove } from '@durak/shared';

/**
 * What the player has picked so far (only the defender ever needs two clicks):
 * a hand card waiting for its target, or an attack card waiting for the card that covers it.
 */
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'hand'; readonly card: Card }
  | { readonly kind: 'attack'; readonly index: number };

export const NO_SELECTION: Selection = { kind: 'none' };

export interface ClickResult {
  readonly move: ClientMove | null;
  readonly selection: Selection;
}

type CardMove = Extract<ClientMove, { card: Card }>;

function usesCard(move: ClientMove, card: Card): move is CardMove {
  return 'card' in move && sameCard(move.card, card);
}

function findDefend(moves: readonly ClientMove[], index: number, card: Card): ClientMove | undefined {
  return moves.find((m) => m.type === 'defend' && m.attackIndex === index && sameCard(m.card, card));
}

/** Hand cards to highlight: those that can be played now (or that cover the selected attack card). */
export function isPlayable(card: Card, moves: readonly ClientMove[], selection: Selection): boolean {
  if (selection.kind === 'attack') return findDefend(moves, selection.index, card) !== undefined;
  return moves.some((m) => usesCard(m, card));
}

/** Uncovered attack cards that are a valid click target. */
export function isAttackTarget(index: number, moves: readonly ClientMove[], selection: Selection): boolean {
  if (selection.kind === 'hand') return findDefend(moves, index, selection.card) !== undefined;
  return moves.some((m) => m.type === 'defend' && m.attackIndex === index);
}

/** The transfer slot is offered while the selected hand card can transfer. */
export function transferTarget(moves: readonly ClientMove[], selection: Selection): ClientMove | null {
  if (selection.kind !== 'hand') return null;
  return moves.find((m) => m.type === 'transfer' && sameCard(m.card, selection.card)) ?? null;
}

export function clickHandCard(card: Card, moves: readonly ClientMove[], selection: Selection): ClickResult {
  if (selection.kind === 'hand' && sameCard(selection.card, card)) return { move: null, selection: NO_SELECTION };
  if (selection.kind === 'attack') {
    const defend = findDefend(moves, selection.index, card);
    if (defend) return { move: defend, selection: NO_SELECTION };
  }
  const attack = moves.find((m) => m.type === 'attack' && sameCard(m.card, card));
  if (attack) return { move: attack, selection: NO_SELECTION };
  // Defend / transfer need a target: remember the card.
  if (moves.some((m) => usesCard(m, card))) return { move: null, selection: { kind: 'hand', card } };
  return { move: null, selection };
}

export function clickAttackCard(index: number, moves: readonly ClientMove[], selection: Selection): ClickResult {
  if (selection.kind === 'hand') {
    const defend = findDefend(moves, index, selection.card);
    if (defend) return { move: defend, selection: NO_SELECTION };
  }
  if (selection.kind === 'attack' && selection.index === index) return { move: null, selection: NO_SELECTION };
  if (moves.some((m) => m.type === 'defend' && m.attackIndex === index)) {
    return { move: null, selection: { kind: 'attack', index } };
  }
  return { move: null, selection };
}

export function clickTransfer(moves: readonly ClientMove[], selection: Selection): ClickResult {
  const move = transferTarget(moves, selection);
  return move ? { move, selection: NO_SELECTION } : { move: null, selection };
}
