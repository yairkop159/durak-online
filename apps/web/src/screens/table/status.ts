import type { ClientMove, PlayerView } from '@durak/shared';
import type { Strings } from '../../i18n';

/** One line telling the viewer what is going on (and whether it's their turn). */
export function statusLine(view: PlayerView, moves: readonly ClientMove[], nameOf: (id: string) => string, s: Strings): string {
  const phase = view.phase;
  const me = view.viewerId;
  if (phase.kind === 'finished') return '';
  if (me !== null && view.players.find((p) => p.id === me)?.finished) return s.table.status.youAreOut;
  if (phase.kind === 'awaitingAttack') {
    return view.attackerId === me ? s.table.status.youAttack : s.table.status.waitAttack(nameOf(view.attackerId));
  }
  if (view.defenderId === me) return phase.taking ? s.table.status.youTake : s.table.status.youDefend;
  if (moves.some((m) => m.type === 'attack')) return s.table.status.youThrowIn;
  const defender = nameOf(view.defenderId);
  return phase.taking ? s.table.status.othersTake(defender) : s.table.status.othersDefend(defender);
}
