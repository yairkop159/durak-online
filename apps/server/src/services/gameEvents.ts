import type { GameState } from '@durak/game-engine';
import { cardId, type Card, type PlayerId, type TablePair } from '@durak/shared';

/**
 * What happened between two consecutive committed states, in public terms only: every event is
 * something all players saw (a card put face-up on the table, a bout resolution, a player going
 * out). The full states are used only to attribute a now-visible card to the hand it left.
 * Used for the end-of-game stats and the bots' reactions. Pure.
 */
export type PlayRole = 'open' | 'throwIn' | 'defend' | 'transfer';

export type GameEvent =
  | { readonly type: 'played'; readonly by: PlayerId; readonly card: Card; readonly role: PlayRole }
  | {
      readonly type: 'resolved';
      readonly outcome: 'beaten' | 'taken';
      readonly defenderId: PlayerId;
      /** Attack cards on the final table. */
      readonly pairs: number;
      /** Every card on the final table (attack + defense). */
      readonly cards: number;
    }
  | { readonly type: 'wentOut'; readonly playerId: PlayerId }
  | { readonly type: 'finished'; readonly durak: PlayerId | null };

/** Whether `next` resolved a bout that was running in `prev` (not a resign/abandon). */
export function resolvedBout(prev: GameState, next: GameState): boolean {
  if (prev.phase.kind === 'finished' || next.lastBout === null) return false;
  if (next.boutNumber !== prev.boutNumber) return true;
  // The final bout of a game resolves without a new bout starting.
  return next.phase.kind === 'finished' && JSON.stringify(next.lastBout) !== JSON.stringify(prev.lastBout);
}

/**
 * Events for one committed step. A commit contains at most one bout resolution (a move, or one
 * `applyTimeout`); the bots-only fast-forward calls this per move.
 */
export function gameEvents(prev: GameState, next: GameState): GameEvent[] {
  if (prev.phase.kind === 'finished') return [];
  const resolved = resolvedBout(prev, next);
  const finalTable: readonly TablePair[] = resolved ? next.lastBout!.table : next.table;
  // A table that shrank without a resolution is a new game or an inconsistency: report nothing.
  if (finalTable.length < prev.table.length) return [];

  const owner = new Map<string, PlayerId>();
  for (const p of prev.players) for (const c of p.hand) owner.set(cardId(c), p.id);
  const events: GameEvent[] = [];
  const played = (card: Card, role: PlayRole) => {
    const by = owner.get(cardId(card));
    if (by !== undefined) events.push({ type: 'played', by, card, role });
  };

  const defenderChanged = !resolved && next.defenderIndex !== prev.defenderIndex;
  for (let i = 0; i < finalTable.length; i++) {
    const pair = finalTable[i]!;
    const before = prev.table[i];
    if (!before) {
      const role: PlayRole = i === 0 ? 'open' : defenderChanged ? 'transfer' : 'throwIn';
      played(pair.attack, role);
      if (pair.defense) played(pair.defense, 'defend');
    } else if (!before.defense && pair.defense) {
      played(pair.defense, 'defend');
    }
  }

  if (resolved) {
    const last = next.lastBout!;
    events.push({
      type: 'resolved',
      outcome: last.outcome,
      defenderId: last.defenderId,
      pairs: last.table.length,
      cards: last.table.reduce((n, p) => n + (p.defense ? 2 : 1), 0),
    });
    // Players only go out at the end of a bout (a resign/abandon also fills finishOrder: not "out").
    for (const id of next.finishOrder) if (!prev.finishOrder.includes(id)) events.push({ type: 'wentOut', playerId: id });
  }
  if (next.phase.kind === 'finished') events.push({ type: 'finished', durak: next.phase.durak });
  return events;
}

/**
 * Who went out in one committed step (one group: they went out together), the durak excluded.
 * Empty when nobody went out. A resign or abandon appends everyone still in at once: one group.
 */
export function finishGroupOf(prev: GameState, next: GameState): PlayerId[] {
  const durak = next.phase.kind === 'finished' ? next.phase.durak : null;
  return next.finishOrder.filter((id) => !prev.finishOrder.includes(id) && id !== durak);
}

/** `groups` after one committed step from `prev` to `next`. */
export function advanceFinishGroups(
  groups: readonly (readonly PlayerId[])[],
  prev: GameState,
  next: GameState,
): (readonly PlayerId[])[] {
  const group = finishGroupOf(prev, next);
  return group.length > 0 ? [...groups, group] : [...groups];
}
