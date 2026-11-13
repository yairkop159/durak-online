import type { ClientMove, PlayerView } from '@durak/shared';
import type { TipId } from '../settings/settings';

/**
 * The first-game tip for the situation on screen (pure), or null. Each tip is shown until it is
 * dismissed or its move is made once. Order matters: a transfer chance is rarer than a defense.
 */
export function tipFor(view: PlayerView, moves: readonly ClientMove[], seen: readonly TipId[]): TipId | null {
  if (view.viewerId === null || view.phase.kind === 'finished' || moves.length === 0) return null;
  const unseen = (id: TipId) => !seen.includes(id);
  const has = (type: ClientMove['type']) => moves.some((m) => m.type === type);
  const defending = view.defenderId === view.viewerId;

  if (has('transfer') && unseen('firstTransfer')) return 'firstTransfer';
  if (defending && has('defend') && unseen('firstDefense')) return 'firstDefense';
  if (!defending && has('attack')) {
    if (view.phase.kind === 'awaitingAttack') return unseen('firstAttack') ? 'firstAttack' : null;
    return unseen('firstThrowIn') ? 'firstThrowIn' : null;
  }
  return null;
}

/** The tip a move "uses up": making it counts as having learned the tip. */
export function tipLearnedBy(tip: TipId, move: ClientMove): boolean {
  switch (tip) {
    case 'firstAttack':
    case 'firstThrowIn':
      return move.type === 'attack' || move.type === 'pass';
    case 'firstDefense':
      return move.type === 'defend' || move.type === 'take';
    case 'firstTransfer':
      return move.type === 'transfer';
  }
}
