import { chooseBotMove, createRng, getLegalMovesForView, GreedyBot } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import type { BotJob } from './job.js';

/**
 * One bot decision from the job alone (shared by the worker thread and the in-process runner).
 * `now` is the caller's clock, used only for a `thinkMs` budget.
 */
export function decide(job: BotJob, now: () => number): ClientMove | null {
  const { view, knowledge, options } = job;
  const { policy, seed } = options;
  if (policy.kind === 'greedy') {
    const rng = createRng(seed);
    const legal = getLegalMovesForView(view);
    if (legal.length === 0) return null;
    if (rng.next() < policy.randomRate) return legal[rng.nextInt(legal.length)]!;
    return GreedyBot.choose(view, knowledge, rng);
  }
  const budget =
    'iterations' in policy.budget
      ? { iterations: policy.budget.iterations }
      : { deadlineMs: now() + policy.budget.thinkMs, now };
  return chooseBotMove(view, knowledge, { seed, budget });
}

/** Last-resort decision on the main thread (timeouts, crashes, bad results): cheap and always legal. */
export function fallbackDecision(job: BotJob): ClientMove | null {
  return GreedyBot.choose(job.view, job.knowledge, createRng(job.options.seed));
}
