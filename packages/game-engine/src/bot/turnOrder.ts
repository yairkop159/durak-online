import { canThrowIn, isFinished } from '../rules.js';
import type { GameState } from '../state.js';

/**
 * Durak lets several players act at the same time; simulations need one "player to move".
 * Canonical order (used by the IS-MCTS tree below the root, by rollouts and by the benchmark):
 *   1. finished                                   -> nobody (-1)
 *   2. awaitingAttack                             -> the main attacker
 *   3. bout, defender not taking, a card uncovered -> the defender (defend / transfer / take)
 *   4. otherwise -> the first non-defender clockwise from the main attacker who is still in, has not
 *      passed and can throw in (throw-in or pass)
 * Attackers therefore throw in after seeing the defense. If nobody qualifies in step 4 the engine
 * has already ended the bout, so -1 there means an engine invariant was broken.
 */
export function canonicalActor(state: GameState): number {
  const phase = state.phase;
  if (phase.kind === 'finished') return -1;
  if (phase.kind === 'awaitingAttack') return state.attackerIndex;
  if (!phase.taking && state.table.some((p) => p.defense === null)) return state.defenderIndex;
  const n = state.players.length;
  for (let step = 0; step < n; step++) {
    const idx = (state.attackerIndex + step) % n;
    if (idx === state.defenderIndex || isFinished(state, idx)) continue;
    if (phase.passed.includes(state.players[idx]!.id)) continue;
    if (canThrowIn(state, idx)) return idx;
  }
  return -1;
}
