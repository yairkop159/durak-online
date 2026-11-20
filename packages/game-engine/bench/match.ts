import type { GameMode, PlayerView } from '@durak/shared';
import { initKnowledge, updateKnowledge, type Bot, type PublicKnowledge } from '../src/bot/index.js';
import { canonicalActor } from '../src/bot/turnOrder.js';
import { applyMove, createGame, createRng, sanitizeStateForPlayer, validateMove, type GameState } from '../src/index.js';

/**
 * Plays one game between bots. The harness owns the real `GameState`; every bot only ever receives
 * its own sanitized view and its own `PublicKnowledge`, updated from consecutive views on every step.
 * The player to move is `canonicalActor` (see src/bot/turnOrder.ts). Every chosen move is checked
 * with `validateMove` against the real state.
 */
export interface MatchOptions {
  readonly players: number;
  readonly mode: GameMode;
  readonly seed: number;
  /** 2v2 team mode (4 players; seats 0+2 vs 1+3). */
  readonly teams?: boolean;
  /** One bot per seat. */
  readonly bots: readonly Bot[];
  /** Moves before the game is declared abandoned. Default 3000. */
  readonly maxMoves?: number;
  /** Clock for per-seat decision timing (the bench passes `performance.now`). */
  readonly clock?: () => number;
  /** Called after every step (and once at the start) with the real state and every seat's view and knowledge. */
  readonly onStep?: (state: GameState, views: readonly PlayerView[], knowledge: readonly PublicKnowledge[]) => void;
}

export interface MatchResult {
  readonly final: GameState;
  /** Seat of the durak; null for a draw or an abandoned game. */
  readonly durakSeat: number | null;
  readonly abandoned: boolean;
  readonly moves: number;
  readonly decisions: readonly { count: number; ms: number }[];
}

export function playMatch(options: MatchOptions): MatchResult {
  const ids = Array.from({ length: options.players }, (_, i) => `p${i}`);
  const config = options.teams ? { mode: options.mode, teams: true } : { mode: options.mode };
  const created = createGame({ playerIds: ids, seed: options.seed, config });
  if (!created.ok) throw new Error(created.error.message);
  let state = created.value;
  const rng = createRng(options.seed ^ 0x2545f491);
  const clock = options.clock ?? (() => 0);
  const maxMoves = options.maxMoves ?? 3000;

  let views = ids.map((id) => sanitizeStateForPlayer(state, id));
  let knowledge = views.map((v) => initKnowledge(v));
  const decisions = ids.map(() => ({ count: 0, ms: 0 }));
  options.onStep?.(state, views, knowledge);

  let moves = 0;
  while (state.phase.kind !== 'finished') {
    if (moves >= maxMoves) {
      return { final: state, durakSeat: null, abandoned: true, moves, decisions };
    }
    const seat = canonicalActor(state);
    if (seat < 0) throw new Error('No player to move in an unfinished game');
    const bot = options.bots[seat]!;
    const t0 = clock();
    const choice = bot.choose(views[seat]!, knowledge[seat]!, rng);
    decisions[seat]!.ms += clock() - t0;
    decisions[seat]!.count++;
    if (!choice) throw new Error(`${bot.name} returned no move for seat ${seat}`);
    const move = { ...choice, playerId: ids[seat]! };
    const error = validateMove(state, move);
    if (error) throw new Error(`${bot.name} chose an illegal move ${JSON.stringify(move)}: ${error.code}`);
    const result = applyMove(state, move);
    if (!result.ok) throw new Error(result.error.message);
    state = result.value;
    moves++;

    const next = ids.map((id) => sanitizeStateForPlayer(state, id));
    knowledge = knowledge.map((k, i) => updateKnowledge(k, views[i]!, next[i]!));
    views = next;
    options.onStep?.(state, views, knowledge);
  }
  const durak = state.phase.durak;
  return { final: state, durakSeat: durak === null ? null : ids.indexOf(durak), abandoned: false, moves, decisions };
}
