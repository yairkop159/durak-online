import type { ClientMove, PlayerId, PlayerView } from '@durak/shared';

/**
 * Who the game is waiting on, judged from the viewer's view alone (opponents' hands are hidden,
 * so for them this is an approximation; for the viewer it is exact via their legal moves):
 * - awaitingAttack: the main attacker;
 * - bout: the defender while a card is uncovered and they aren't taking; otherwise the
 *   non-defenders still in who haven't passed (they may still throw in).
 */
export function awaitedPlayers(view: PlayerView, myMoves: readonly ClientMove[]): Set<PlayerId> {
  const phase = view.phase;
  const out = new Set<PlayerId>();
  if (phase.kind === 'finished') return out;
  if (phase.kind === 'awaitingAttack') {
    out.add(view.attackerId);
    return out;
  }
  const uncovered = view.table.some((p) => p.defense === null);
  if (uncovered && !phase.taking) out.add(view.defenderId);
  else {
    for (const p of view.players) {
      if (p.id !== view.defenderId && !p.finished && p.handCount > 0 && !phase.passed.includes(p.id)) out.add(p.id);
    }
  }
  // The viewer: exact.
  const me = view.viewerId;
  if (me !== null) {
    if (myMoves.length > 0) out.add(me);
    else out.delete(me);
  }
  return out;
}
