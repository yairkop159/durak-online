import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGame, getLegalMovesForView, GreedyBot, initKnowledge, createRng, sanitizeStateForPlayer } from '@durak/game-engine';
import { describe, expect, it, vi } from 'vitest';
import type { BotJob } from '../src/bot/job.js';
import { WorkerPoolRunner, type BotWorkerLike } from '../src/bot/WorkerPoolRunner.js';
import { createSystemScheduler, systemClock } from '../src/services/scheduling.js';
import { FakeTime } from './helpers/fakeTime.js';

/** A job for the player to act in a fresh 2-player game. */
function makeJob(jobId = 1): BotJob {
  const created = createGame({ playerIds: ['a', 'b'], seed: 9, config: {} });
  if (!created.ok) throw new Error('setup');
  const state = created.value;
  const me = state.players[state.attackerIndex]!.id;
  const view = sanitizeStateForPlayer(state, me);
  return {
    jobId,
    view,
    knowledge: initKnowledge(view),
    options: { seed: 123, policy: { kind: 'ismcts', budget: { iterations: 20 } } },
  };
}

const greedyFor = (job: BotJob) => GreedyBot.choose(job.view, job.knowledge, createRng(job.options.seed));

type Behaviour = 'hang' | 'crash' | 'answer' | 'garbage';

class FakeWorker extends EventEmitter implements BotWorkerLike {
  terminated = false;
  received: BotJob[] = [];
  constructor(private readonly behaviour: Behaviour) {
    super();
  }
  postMessage(job: BotJob): void {
    this.received.push(job);
    queueMicrotask(() => {
      if (this.behaviour === 'crash') this.emit('error', new Error('boom'));
      if (this.behaviour === 'answer') {
        const legal = getLegalMovesForView(job.view);
        this.emit('message', { jobId: job.jobId, move: legal[legal.length - 1] });
      }
      if (this.behaviour === 'garbage') this.emit('message', { jobId: job.jobId, move: { type: 'nuke' } });
      // 'hang': never answers
    });
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function pool(behaviours: Behaviour[], time = new FakeTime()) {
  const workers: FakeWorker[] = [];
  const log = { error: vi.fn() };
  const runner = new WorkerPoolRunner({
    size: 1,
    jobTimeoutMs: 2_000,
    clock: time,
    scheduler: time,
    log,
    factory: () => {
      const w = new FakeWorker(behaviours[workers.length] ?? 'answer');
      workers.push(w);
      return w;
    },
  });
  return { runner, workers, time, log };
}

const never = () => new AbortController().signal;

describe('WorkerPoolRunner', () => {
  it('a job that times out resolves with the GreedyBot fallback; the stuck worker is replaced and serves the next job', async () => {
    const { runner, workers, time } = pool(['hang', 'answer']);
    const job = makeJob(1);
    const result = runner.run(job, never());
    await time.advanceBy(1_999);
    expect(workers).toHaveLength(1);
    await time.advanceBy(1);
    expect(await result).toEqual(greedyFor(job));
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);

    const next = makeJob(2);
    const legal = getLegalMovesForView(next.view);
    expect(await runner.run(next, never())).toEqual(legal[legal.length - 1]);
    expect(workers[1]!.received.map((j) => j.jobId)).toEqual([2]);
  });

  it('a crashed worker: fallback move, worker replaced', async () => {
    const { runner, workers, log } = pool(['crash', 'answer']);
    const job = makeJob(1);
    expect(await runner.run(job, never())).toEqual(greedyFor(job));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(log.error).toHaveBeenCalled();
    expect(runner.stats).toEqual({ workers: 1, busy: 0, queued: 0 });
  });

  it('a malformed result is rejected in favour of the fallback', async () => {
    const { runner } = pool(['garbage']);
    const job = makeJob(1);
    expect(await runner.run(job, never())).toEqual(greedyFor(job));
  });

  it('queues FIFO when every worker is busy; aborted queued jobs are dropped without running', async () => {
    const { runner, workers, time } = pool(['hang', 'answer']);
    const first = runner.run(makeJob(1), never());
    const abort = new AbortController();
    const second = runner.run(makeJob(2), abort.signal);
    const third = runner.run(makeJob(3), never());
    expect(runner.stats).toEqual({ workers: 1, busy: 1, queued: 2 });
    abort.abort();
    expect(await second).toBeNull();
    await time.advanceBy(2_000); // job 1 times out -> replacement worker takes job 3
    await first;
    await third;
    expect(workers[1]!.received.map((j) => j.jobId)).toEqual([3]);
  });

  it('dispose terminates the workers and settles pending jobs', async () => {
    const { runner, workers } = pool(['hang']);
    const pending = runner.run(makeJob(1), never());
    await new Promise((r) => setImmediate(r));
    await runner.dispose();
    expect(await pending).toBeNull();
    expect(workers[0]!.terminated).toBe(true);
    expect(await runner.run(makeJob(2), never())).toBeNull();
  });
});

// The real worker imports @durak/game-engine through its package entry (dist), like production.
const engineDist = fileURLToPath(new URL('../../../packages/game-engine/dist/bot/index.js', import.meta.url));
const realWorker = existsSync(engineDist) ? describe : describe.skip;
if (!existsSync(engineDist)) {
  console.warn('game-engine dist is missing or predates the bot: skipping the real worker test (npm run build --workspaces)');
}

realWorker('WorkerPoolRunner with real worker_threads', () => {
  it('runs an IS-MCTS job in a worker thread and returns a legal move', async () => {
    const log = { error: vi.fn() };
    const scheduler = createSystemScheduler(systemClock, () => undefined);
    const runner = new WorkerPoolRunner({ size: 1, jobTimeoutMs: 15_000, clock: systemClock, scheduler, log });
    try {
      const job = makeJob(1);
      const move = await runner.run(job, never());
      expect(getLegalMovesForView(job.view)).toContainEqual(move);
      expect(log.error).not.toHaveBeenCalled(); // not the fallback
    } finally {
      await runner.dispose();
    }
  });
});
