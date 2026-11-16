import type { Clock, Scheduler, TimerHandle } from '../services/scheduling.js';
import { isRated, type GameResultInput } from './gameResult.js';
import { errorName, isUnavailable, type ResultStore } from './ports.js';

export interface ResultQueueLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ResultQueueSettings {
  /** Pending results kept at most (the oldest is dropped beyond it). */
  readonly maxSize: number;
  /** A result still failing this long after the game ended is dropped. */
  readonly maxAgeMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Non-availability errors (a bug, a constraint) are retried this many times, then dropped. */
  readonly maxErrorAttempts: number;
}

export const DEFAULT_RESULT_QUEUE_SETTINGS: ResultQueueSettings = {
  maxSize: 1000,
  maxAgeMs: 60 * 60_000,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  maxErrorAttempts: 3,
};

interface Pending {
  readonly input: GameResultInput;
  readonly queuedAt: number;
  attempts: number;
}

/**
 * Writes finished games to the ResultStore one at a time, off the game path: `enqueue` never
 * awaits and never throws. While Postgres is down results wait and are retried with exponential
 * backoff (2 s → 5 min) for up to an hour; the store is idempotent by gameId, so retrying (or
 * re-submitting at startup) can never rate a game twice. Only game ids and counts are logged.
 */
export class ResultQueue {
  private readonly pending: Pending[] = [];
  private readonly settings: ResultQueueSettings;
  private running: Promise<void> | null = null;
  private timer: TimerHandle | null = null;
  private disposed = false;

  constructor(
    private readonly deps: {
      readonly store: ResultStore;
      readonly clock: Clock;
      readonly scheduler: Scheduler;
      readonly log: ResultQueueLogger;
      readonly settings?: Partial<ResultQueueSettings>;
    },
  ) {
    this.settings = { ...DEFAULT_RESULT_QUEUE_SETTINGS, ...deps.settings };
  }

  get size(): number {
    return this.pending.length;
  }

  enqueue(input: GameResultInput): void {
    if (this.disposed || this.pending.some((p) => p.input.gameId === input.gameId)) return;
    this.pending.push({ input, queuedAt: this.deps.clock.now(), attempts: 0 });
    while (this.pending.length > this.settings.maxSize) {
      const dropped = this.pending.shift()!;
      this.deps.log.error({ gameId: dropped.input.gameId }, 'game result dropped: result queue full');
    }
    this.kick();
  }

  /** Retry now (e.g. the database just came back). */
  kick(): void {
    if (this.disposed) return;
    if (this.timer) {
      this.deps.scheduler.cancel(this.timer);
      this.timer = null;
    }
    if (!this.running) this.running = this.drain().finally(() => (this.running = null));
  }

  /** Waits (bounded) for the write in flight: used on shutdown before the database closes. */
  async flush(timeoutMs: number): Promise<void> {
    const running = this.running;
    if (!running) return;
    await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.deps.scheduler.cancel(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    const { store, clock, log } = this.deps;
    while (this.pending.length > 0 && !this.disposed) {
      const item = this.pending[0]!;
      const { gameId } = item.input;
      try {
        const outcome = await store.recordGame(item.input);
        this.pending.shift();
        log.info({ gameId, outcome, rated: isRated(item.input), attempts: item.attempts + 1 }, 'game result stored');
      } catch (error) {
        item.attempts += 1;
        const unavailable = isUnavailable(error);
        const tooOld = clock.now() - item.queuedAt >= this.settings.maxAgeMs;
        if (tooOld || (!unavailable && item.attempts >= this.settings.maxErrorAttempts)) {
          this.pending.shift();
          log.error({ gameId, attempts: item.attempts, err: errorName(error) }, 'game result dropped');
          continue;
        }
        const delay = Math.min(this.settings.maxDelayMs, this.settings.baseDelayMs * 2 ** (item.attempts - 1));
        log.warn(
          { gameId, attempts: item.attempts, retryInMs: delay, pending: this.pending.length, err: errorName(error) },
          unavailable ? 'game result not stored yet: postgres unavailable' : 'game result not stored yet',
        );
        this.timer = this.deps.scheduler.schedule(clock.now() + delay, async () => {
          this.timer = null;
          this.kick();
        });
        return;
      }
    }
  }
}
