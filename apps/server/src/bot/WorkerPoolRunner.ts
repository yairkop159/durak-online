import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { ClientMoveSchema, type ClientMove } from '@durak/shared';
import type { Clock, Scheduler, TimerHandle } from '../services/scheduling.js';
import { fallbackDecision } from './decide.js';
import type { BotJob, BotJobResult, BotRunner } from './job.js';

/** The part of `worker_threads.Worker` the pool uses (tests inject fakes). */
export interface BotWorkerLike {
  postMessage(job: BotJob): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type BotWorkerFactory = () => BotWorkerLike;

export interface WorkerPoolOptions {
  /** Default: cores - 1, at least 1. */
  readonly size?: number;
  /** Per job, from submission. On expiry the job falls back to GreedyBot. */
  readonly jobTimeoutMs: number;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly factory?: BotWorkerFactory;
  readonly log: { error(obj: object, msg: string): void };
}

export function defaultPoolSize(): number {
  return Math.max(1, availableParallelism() - 1);
}

/** Spawns `botWorker` from source (.ts, under tsx / vitest) or from dist (.js). */
export const defaultWorkerFactory: BotWorkerFactory = () => {
  const fromSource = import.meta.url.endsWith('.ts');
  const url = new URL(fromSource ? './botWorker.ts' : './botWorker.js', import.meta.url);
  // A worker started from a .ts file needs the tsx loader (tsx propagates it already when the
  // server runs under tsx; vitest does not).
  const hasTsx = process.execArgv.some((a) => a.includes('tsx'));
  return new Worker(url, fromSource && !hasTsx ? { execArgv: [...process.execArgv, '--import', 'tsx'] } : {});
};

interface Pending {
  readonly job: BotJob;
  readonly resolve: (move: ClientMove | null) => void;
  settled: boolean;
  timer: TimerHandle | null;
  slot: Slot | null;
}

interface Slot {
  worker: BotWorkerLike;
  current: Pending | null;
}

const ResultSchema = ClientMoveSchema.nullable();

/**
 * Fixed-size worker_threads pool with a FIFO queue. The game must never stall on a bot:
 * a job that times out, a worker that crashes, or a malformed result all resolve with the
 * main-thread GreedyBot fallback, and a stuck or dead worker is replaced.
 * Aborted jobs are dropped from the queue; a running job is not interrupted (its result is ignored).
 */
export class WorkerPoolRunner implements BotRunner {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly factory: BotWorkerFactory;
  private readonly size: number;
  private disposed = false;

  constructor(private readonly options: WorkerPoolOptions) {
    this.factory = options.factory ?? defaultWorkerFactory;
    this.size = Math.max(1, options.size ?? defaultPoolSize());
  }

  /** Diagnostics for tests. */
  get stats(): { workers: number; busy: number; queued: number } {
    return { workers: this.slots.length, busy: this.slots.filter((s) => s.current).length, queued: this.queue.length };
  }

  run(job: BotJob, signal: AbortSignal): Promise<ClientMove | null> {
    if (this.disposed || signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const pending: Pending = { job, resolve, settled: false, timer: null, slot: null };
      const { scheduler, clock, jobTimeoutMs } = this.options;
      pending.timer = scheduler.schedule(clock.now() + jobTimeoutMs, async () => {
        pending.timer = null;
        this.onTimeout(pending);
      });
      signal.addEventListener('abort', () => this.onAbort(pending), { once: true });
      this.queue.push(pending);
      this.dispatch();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const pending of this.queue.splice(0)) this.settle(pending, null);
    const workers = this.slots.splice(0).map((s) => {
      if (s.current) this.settle(s.current, null);
      return s.worker;
    });
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }

  // ------------------------------------------------------------------ internals

  private dispatch(): void {
    while (!this.disposed && this.queue.length > 0) {
      const slot = this.slots.find((s) => s.current === null) ?? this.spawn();
      if (!slot) return;
      const pending = this.queue.shift()!;
      if (pending.settled) continue;
      slot.current = pending;
      pending.slot = slot;
      try {
        slot.worker.postMessage(pending.job);
      } catch (error) {
        this.options.log.error({ err: error }, 'bot worker postMessage failed');
        this.replace(slot);
        this.settle(pending, fallbackDecision(pending.job));
      }
    }
  }

  /** Lazily grows the pool up to `size`; null when every slot exists and is busy. */
  private spawn(): Slot | null {
    if (this.slots.length >= this.size) return null;
    const slot: Slot = { worker: this.factory(), current: null };
    this.slots.push(slot);
    this.listen(slot, slot.worker);
    return slot;
  }

  private listen(slot: Slot, worker: BotWorkerLike): void {
    worker.on('message', (message) => {
      if (slot.worker !== worker) return; // a replaced worker
      const pending = slot.current;
      const result = message as Partial<BotJobResult> | null;
      if (!pending || !result || result.jobId !== pending.job.jobId) return;
      slot.current = null;
      pending.slot = null;
      const parsed = ResultSchema.safeParse(result.move);
      const move = result.failed || !parsed.success ? fallbackDecision(pending.job) : parsed.data;
      if (result.failed || !parsed.success) this.options.log.error({ jobId: pending.job.jobId }, 'bot worker result rejected');
      this.settle(pending, move);
      this.dispatch();
    });
    const onCrash = (reason: unknown) => {
      if (slot.worker !== worker || this.disposed) return;
      this.options.log.error({ err: reason }, 'bot worker crashed; replacing it');
      const pending = slot.current;
      this.replace(slot);
      if (pending) this.settle(pending, fallbackDecision(pending.job));
      this.dispatch();
    };
    worker.on('error', onCrash);
    worker.on('exit', (code) => onCrash(new Error(`bot worker exited with code ${code}`)));
  }

  /** Terminates the slot's worker and puts a fresh one in its place. */
  private replace(slot: Slot): void {
    const old = slot.worker;
    slot.current = null;
    slot.worker = this.factory();
    this.listen(slot, slot.worker);
    old.terminate().catch(() => 0);
  }

  private onTimeout(pending: Pending): void {
    if (pending.settled) return;
    this.options.log.error({ jobId: pending.job.jobId }, 'bot job timed out; using the greedy fallback');
    const slot = pending.slot;
    if (slot) {
      this.replace(slot); // the worker is stuck on this job
    } else {
      const i = this.queue.indexOf(pending);
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.settle(pending, fallbackDecision(pending.job));
    this.dispatch();
  }

  private onAbort(pending: Pending): void {
    if (pending.settled) return;
    const i = this.queue.indexOf(pending);
    if (i >= 0) this.queue.splice(i, 1);
    // A running job keeps its worker busy until it answers; its result is ignored.
    this.settle(pending, null);
  }

  private settle(pending: Pending, move: ClientMove | null): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) this.options.scheduler.cancel(pending.timer);
    pending.timer = null;
    pending.resolve(move);
  }
}
