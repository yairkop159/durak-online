import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';
import type { GameMode } from '@durak/shared';
import { searchBotMove } from '../src/bot/ismcts.js';
import { GreedyBot, RandomBot, type Bot } from '../src/index.js';
import { playMatch } from './match.js';

/**
 * One benchmark game: IS-MCTS in `ismctsSeat`, the opponent bot in every other seat. With `teams`
 * (2v2, 4 players) IS-MCTS plays both `ismctsSeat` and its partner `ismctsSeat + 2`, each seat with
 * its own view and knowledge; the opponent bot plays the other team.
 */
export interface GameTask {
  readonly configId: number;
  readonly players: number;
  readonly mode: GameMode;
  readonly teams?: boolean;
  readonly opponent: 'random' | 'greedy';
  readonly seed: number;
  readonly ismctsSeat: number;
  readonly budget: { readonly kind: 'iterations'; readonly iterations: number } | { readonly kind: 'deadline'; readonly ms: number };
}

export interface GameOutcome {
  readonly configId: number;
  readonly ismctsSeat: number;
  readonly durakSeat: number | null;
  readonly abandoned: boolean;
  readonly moves: number;
  /** IS-MCTS decisions that actually searched (more than one legal move). */
  readonly searches: number;
  readonly searchMs: number;
  readonly iterations: number;
  /** All IS-MCTS decisions, including the trivial single-move ones. */
  readonly decisions: number;
  readonly decisionMs: number;
}

export function runGame(task: GameTask): GameOutcome {
  const stats = { searches: 0, searchMs: 0, iterations: 0 };
  const ismcts: Bot = {
    name: 'ismcts',
    choose(view, knowledge, rng) {
      const t0 = performance.now();
      const budget =
        task.budget.kind === 'iterations'
          ? { iterations: task.budget.iterations }
          : { deadlineMs: t0 + task.budget.ms, now: () => performance.now() };
      const result = searchBotMove(view, knowledge, { seed: rng.nextInt(0x7fffffff), budget });
      if (result.iterations > 0) {
        stats.searches++;
        stats.searchMs += performance.now() - t0;
        stats.iterations += result.iterations;
      }
      return result.move;
    },
  };
  const opponent = task.opponent === 'random' ? RandomBot : GreedyBot;
  const isMine = (seat: number) => seat === task.ismctsSeat || (task.teams === true && seat % 2 === task.ismctsSeat % 2);
  const bots = Array.from({ length: task.players }, (_, seat) => (isMine(seat) ? ismcts : opponent));
  const result = playMatch({
    players: task.players,
    mode: task.mode,
    seed: task.seed,
    teams: task.teams === true,
    bots,
    clock: () => performance.now(),
  });
  const mine = result.decisions
    .filter((_, seat) => isMine(seat))
    .reduce((sum, d) => ({ count: sum.count + d.count, ms: sum.ms + d.ms }), { count: 0, ms: 0 });
  return {
    configId: task.configId,
    ismctsSeat: task.ismctsSeat,
    durakSeat: result.durakSeat,
    abandoned: result.abandoned,
    moves: result.moves,
    searches: stats.searches,
    searchMs: stats.searchMs,
    iterations: stats.iterations,
    decisions: mine.count,
    decisionMs: mine.ms,
  };
}

// Worker protocol: receive a task, post its outcome, repeat until 'done'.
parentPort?.on('message', (message: GameTask | 'done') => {
  if (message === 'done') {
    parentPort?.close();
    return;
  }
  parentPort?.postMessage(runGame(message));
});
