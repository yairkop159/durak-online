import { SUITS, type Card, type GameError, type Move, type PlayerId, type Suit } from '@durak/shared';
import { err, gameError, ok, type Result } from './result.js';
import { applyMove, canThrowIn, isFinished, playerIndex, validateMove } from './rules.js';
import type { GameState } from './state.js';

/** Lowest rank first; equal ranks broken by suit order S, C, D, H. */
function cardKey(card: Card): number {
  return card.rank * SUITS.length + SUITS.indexOf(card.suit);
}

/** The card a timed-out attacker opens with: lowest non-trump, else lowest trump. */
export function timeoutOpeningCard(hand: readonly Card[], trump: Suit): Card | undefined {
  const byKey = (a: Card, b: Card) => cardKey(a) - cardKey(b);
  const nonTrumps = hand.filter((c) => c.suit !== trump).sort(byKey);
  return nonTrumps[0] ?? [...hand].sort(byKey)[0];
}

/**
 * Moves the server applies when the turn deadline expires (see CLAUDE.md "Turn timers & AFK"):
 * - awaitingAttack: the attacker opens with `timeoutOpeningCard`;
 * - bout: the defender takes (if a card is uncovered and they are not already taking), then
 *   every non-defender who can still throw in and has not passed passes, in seat order
 *   starting from the main attacker.
 */
export function getTimeoutMoves(state: GameState): Move[] {
  const phase = state.phase;
  if (phase.kind === 'finished') return [];

  if (phase.kind === 'awaitingAttack') {
    const attacker = state.players[state.attackerIndex];
    const card = attacker ? timeoutOpeningCard(attacker.hand, state.trumpCard.suit) : undefined;
    return attacker && card ? [{ type: 'attack', playerId: attacker.id, card }] : [];
  }

  const moves: Move[] = [];
  const defender = state.players[state.defenderIndex];
  if (defender && !phase.taking && state.table.some((p) => p.defense === null)) {
    moves.push({ type: 'take', playerId: defender.id });
  }
  const n = state.players.length;
  for (let step = 0; step < n; step++) {
    const idx = (state.attackerIndex + step) % n;
    const player = state.players[idx];
    if (!player || idx === state.defenderIndex || isFinished(state, idx)) continue;
    if (!phase.passed.includes(player.id) && canThrowIn(state, idx)) {
      moves.push({ type: 'pass', playerId: player.id });
    }
  }
  return moves;
}

/** Players the game is currently waiting on (the actors of `getTimeoutMoves`). */
export function getAwaitedPlayers(state: GameState): PlayerId[] {
  return [...new Set(getTimeoutMoves(state).map((m) => m.playerId))];
}

export interface TimeoutResult {
  readonly state: GameState;
  /** Players whose timeout move was actually applied. */
  readonly timedOut: readonly PlayerId[];
}

/**
 * Applies the timeout moves in order, each through `applyMove`. A move made obsolete by an
 * earlier one (e.g. a take that already ended the bout) is skipped. Always makes progress:
 * it either opens a bout or ends the current one.
 */
export function applyTimeout(state: GameState): Result<TimeoutResult, GameError> {
  if (state.phase.kind === 'finished') return err(gameError('GAME_FINISHED', 'The game is over'));
  const timedOut: PlayerId[] = [];
  let current = state;
  for (const move of getTimeoutMoves(state)) {
    if (validateMove(current, move) !== null) continue;
    const result = applyMove(current, move);
    if (!result.ok) return err(result.error);
    current = result.value;
    timedOut.push(move.playerId);
  }
  if (current === state) {
    return err(gameError('INVALID_MOVE', 'Timeout produced no move; the game is not waiting on anyone'));
  }
  return ok({ state: current, timedOut });
}

/** Everyone still in the game except `excludeIndex`, in seat order from the main attacker. */
function remainingInSeatOrder(state: GameState, excludeIndex: number): PlayerId[] {
  const ids: PlayerId[] = [];
  const n = state.players.length;
  for (let step = 0; step < n; step++) {
    const i = (state.attackerIndex + step) % n;
    const player = state.players[i];
    if (player && i !== excludeIndex && !isFinished(state, i)) ids.push(player.id);
  }
  return ids;
}

/**
 * The player forfeits: the game ends at once with them as the durak. Everyone else still in
 * the game is appended to `finishOrder` in seat order from the main attacker. Cards are untouched.
 */
export function resign(state: GameState, playerId: PlayerId): Result<GameState, GameError> {
  if (state.phase.kind === 'finished') return err(gameError('GAME_FINISHED', 'The game is over'));
  const idx = playerIndex(state, playerId);
  if (idx === -1) return err(gameError('UNKNOWN_PLAYER', `Unknown player ${playerId}`));
  if (isFinished(state, idx)) return err(gameError('PLAYER_FINISHED', 'A player who is out cannot resign'));

  const finishOrder = [...state.finishOrder, ...remainingInSeatOrder(state, idx)];
  return ok({ ...state, finishOrder, phase: { kind: 'finished', durak: playerId } });
}

/**
 * Ends the game with no durak (used by the server's abandon guard when nobody is playing).
 * Everyone still in the game is appended to `finishOrder`. Cards are untouched.
 * Whether a no-durak ending was a real draw or an abandonment is recorded by the server.
 */
export function abandon(state: GameState): Result<GameState, GameError> {
  if (state.phase.kind === 'finished') return err(gameError('GAME_FINISHED', 'The game is over'));
  const finishOrder = [...state.finishOrder, ...remainingInSeatOrder(state, -1)];
  return ok({ ...state, finishOrder, phase: { kind: 'finished', durak: null } });
}
