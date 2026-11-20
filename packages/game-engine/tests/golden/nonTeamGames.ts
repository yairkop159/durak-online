/**
 * Golden record of non-team games (the proof that team mode leaves every existing mode unchanged).
 *
 * Each case plays a fully deterministic game and hashes everything it saw: every move, every state,
 * every sanitized view and the `PublicKnowledge` of every seat. `nonTeamGolden.json` was generated
 * by `generate.ts` on main's engine BEFORE any team-mode change; `nonTeam.golden.test.ts` replays
 * the cases and must keep matching it. Regenerate it only for a deliberate rule change.
 *
 * Kinds:
 * - `random`: random legal moves (biased away from passing), with an occasional `applyTimeout`.
 * - `bots`: every move chosen by the bots from their own view + knowledge (IS-MCTS with a small
 *   fixed iteration budget, Greedy, Random), so the search, the rewards and the rollouts are covered.
 */
import { createHash } from 'node:crypto';
import type { GameMode, PlayerId, PlayerView } from '@durak/shared';
import {
  applyMove,
  applyTimeout,
  canonicalActor,
  chooseBotMove,
  createGame,
  createRng,
  getLegalMoves,
  getPlayersToAct,
  GreedyBot,
  initKnowledge,
  RandomBot,
  sanitizeStateForPlayer,
  updateKnowledge,
  type GameState,
  type PublicKnowledge,
} from '../../src/index.js';

export type GoldenKind = 'random' | 'bots';

export interface GoldenCase {
  readonly kind: GoldenKind;
  readonly players: number;
  readonly mode: GameMode;
  readonly seed: number;
}

export const GOLDEN_MODES: readonly GameMode[] = ['podkidnoy', 'perevodnoy'];
export const RANDOM_SEEDS = 30;
export const BOT_SEEDS = 4;
const MAX_STEPS = 5000;

export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const mode of GOLDEN_MODES) {
    for (let players = 2; players <= 6; players++) {
      for (let s = 1; s <= RANDOM_SEEDS; s++) cases.push({ kind: 'random', players, mode, seed: s * 104729 + players });
      for (let s = 1; s <= BOT_SEEDS; s++) cases.push({ kind: 'bots', players, mode, seed: s * 7877 + players });
    }
  }
  return cases;
}

export function caseKey(c: GoldenCase): string {
  return `${c.kind}/${c.mode}/${c.players}p/${c.seed}`;
}

class Digest {
  private readonly hash = createHash('sha256');
  add(label: string, value: unknown): void {
    this.hash.update(label);
    this.hash.update(JSON.stringify(value));
    this.hash.update('\n');
  }
  hex(): string {
    return this.hash.digest('hex');
  }
}

/** Advances every seat's knowledge and records every view (and the spectator's). */
function observe(
  digest: Digest,
  prev: GameState,
  next: GameState,
  knowledge: Map<PlayerId, PublicKnowledge>,
): void {
  for (const p of next.players) {
    const prevView = sanitizeStateForPlayer(prev, p.id);
    const nextView = sanitizeStateForPlayer(next, p.id);
    const k = updateKnowledge(knowledge.get(p.id) ?? initKnowledge(prevView), prevView, nextView);
    knowledge.set(p.id, k);
    digest.add(`view:${p.id}`, nextView);
    digest.add(`knowledge:${p.id}`, k);
  }
  digest.add('spectator', sanitizeStateForPlayer(next, null));
}

export function playGoldenCase(c: GoldenCase): string {
  const ids = Array.from({ length: c.players }, (_, i) => `p${i}`);
  const created = createGame({ playerIds: ids, seed: c.seed, config: { mode: c.mode } });
  if (!created.ok) throw new Error(created.error.message);
  let state = created.value;
  const digest = new Digest();
  const knowledge = new Map<PlayerId, PublicKnowledge>();
  for (const p of state.players) {
    const view: PlayerView = sanitizeStateForPlayer(state, p.id);
    knowledge.set(p.id, initKnowledge(view));
  }
  digest.add('initial', state);
  const rng = createRng(c.seed ^ 0x5bd1e995);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (state.phase.kind === 'finished') {
      digest.add('final', state);
      digest.add('steps', step);
      return digest.hex();
    }
    let next: GameState;
    if (c.kind === 'random') {
      if (rng.next() < 0.05) {
        const timed = applyTimeout(state);
        if (!timed.ok) throw new Error(`timeout rejected: ${timed.error.code}`);
        digest.add('timeout', timed.value.timedOut);
        next = timed.value.state;
      } else {
        const actors = getPlayersToAct(state);
        const actor = actors[rng.nextInt(actors.length)]!;
        const moves = getLegalMoves(state, actor);
        const nonPass = moves.filter((m) => m.type !== 'pass');
        const pool = nonPass.length > 0 && rng.next() < 0.7 ? nonPass : moves;
        const move = pool[rng.nextInt(pool.length)]!;
        digest.add('move', move);
        const result = applyMove(state, move);
        if (!result.ok) throw new Error(`legal move rejected: ${result.error.code}`);
        next = result.value;
      }
    } else {
      const seat = canonicalActor(state);
      if (seat < 0) throw new Error('no canonical actor');
      const playerId = state.players[seat]!.id;
      const view = sanitizeStateForPlayer(state, playerId);
      const k = knowledge.get(playerId)!;
      // Seat roles rotate with the seed so every bot sits in every position across the cases.
      const role = (seat + c.seed) % 3;
      const botRng = createRng(c.seed * 31 + step);
      const move =
        role === 0
          ? chooseBotMove(view, k, { seed: c.seed * 1009 + step, budget: { iterations: 40 } })
          : role === 1
            ? GreedyBot.choose(view, k, botRng)
            : RandomBot.choose(view, k, botRng);
      if (move === null) throw new Error('bot found no move');
      digest.add('move', { playerId, move });
      const result = applyMove(state, { ...move, playerId });
      if (!result.ok) throw new Error(`bot move rejected: ${result.error.code}`);
      next = result.value;
    }
    digest.add('state', next);
    observe(digest, state, next, knowledge);
    state = next;
  }
  throw new Error(`${caseKey(c)} did not terminate`);
}
