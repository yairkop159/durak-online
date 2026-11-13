import { abandon, applyTimeout, type GameState } from '@durak/game-engine';
import type { GameEndReason, GameError, PlayerId } from '@durak/shared';

/**
 * Abandon guard: "defender -> take" timeouts alone can cycle forever (see the engine regression
 * test). After this many consecutive timer expiries per player still in the game, with no human
 * move in between, the server abandons the game.
 */
export const ABANDON_EXPIRIES_PER_PLAYER = 3;

export function abandonThreshold(state: GameState): number {
  const stillIn = state.players.filter((p) => !state.finishOrder.includes(p.id)).length;
  return ABANDON_EXPIRIES_PER_PLAYER * Math.max(stillIn, 1);
}

export interface TimeoutStep {
  readonly state: GameState;
  readonly timedOut: readonly PlayerId[];
  /** Consecutive expiries including this one (reset to 0 by any human move). */
  readonly streak: number;
  /** Set when this step ended the game. */
  readonly endReason: GameEndReason | null;
}

/** Pure server policy for one timer expiry: apply the timeout moves, or abandon. */
export function stepOnTimeout(
  state: GameState,
  previousStreak: number,
): { ok: true; value: TimeoutStep } | { ok: false; error: GameError } {
  const streak = previousStreak + 1;
  if (streak >= abandonThreshold(state)) {
    const abandoned = abandon(state);
    if (!abandoned.ok) return abandoned;
    return { ok: true, value: { state: abandoned.value, timedOut: [], streak, endReason: 'abandoned' } };
  }
  const result = applyTimeout(state);
  if (!result.ok) return result;
  const finished = result.value.state.phase.kind === 'finished';
  return {
    ok: true,
    value: { state: result.value.state, timedOut: result.value.timedOut, streak, endReason: finished ? 'normal' : null },
  };
}
