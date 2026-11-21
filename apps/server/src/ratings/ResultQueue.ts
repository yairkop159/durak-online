import type { RatingEntry } from '@durak/shared';
import type { Clock, Scheduler, TimerHandle } from '../services/scheduling.js';
import { isRated, type GameResultInput } from './gameResult.js';
import { errorName, isUnavailable, type ResultStore } from './ports.js';
import type { TournamentResultInput } from './tournamentResult.js';

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

/** One pending write: a finished game, or a tournament that is over. */
type Job =
  | { readonly kind: 'game'; readonly input: GameResultInput }
  | { readonly kind: 'tournament'; readonly input: TournamentResultInput };

interface Pending {
  readonly job: Job;
  readonly queuedAt: number;
  attempts: number;
}

const jobKey = (job: Job): string => (job.kind === 'game' ? `game:${job.input.gameId}` : `tournament:${job.input.tournamentId}`);
/** Ids for logs (never anything else from the job). */
const jobIds = (job: Job): Record<string, string> =>
  job.kind === 'game' ? { gameId: job.input.gameId } : { tournamentId: job.input.tournamentId };

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
      /**
       * Called after a write that this queue committed AND rated (never for a duplicate or an
       * unrated game), outside the drain: it is not awaited, and a failure is only logged.
       */
      readonly onRecorded?: (input: GameResultInput, ratings: readonly RatingEntry[]) => Promise<void> | void;
    },
  ) {
    this.settings = { ...DEFAULT_RESULT_QUEUE_SETTINGS, ...deps.settings };
  }

  get size(): number {
    return this.pending.length;
  }

  enqueue(input: GameResultInput): void {
    this.push({ kind: 'game', input });
  }

  /** A tournament that is over; written after every game queued before it (FIFO). */
  enqueueTournament(input: TournamentResultInput): void {
    this.push({ kind: 'tournament', input });
  }

  private push(job: Job): void {
    const key = jobKey(job);
    if (this.disposed || this.pending.some((p) => jobKey(p.job) === key)) return;
    this.pending.push({ job, queuedAt: this.deps.clock.now(), attempts: 0 });
    while (this.pending.length > this.settings.maxSize) {
      const dropped = this.pending.shift()!;
      this.deps.log.error(jobIds(dropped.job), 'game result dropped: result queue full');
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

  private announce(input: GameResultInput, ratings: readonly RatingEntry[]): void {
    const { onRecorded, log } = this.deps;
    if (!onRecorded) return;
    const fail = (error: unknown) => log.error({ gameId: input.gameId, err: errorName(error) }, 'rating announcement failed');
    try {
      void Promise.resolve(onRecorded(input, ratings)).catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  private async drain(): Promise<void> {
    const { store, clock, log } = this.deps;
    while (this.pending.length > 0 && !this.disposed) {
      const item = this.pending[0]!;
      const { job } = item;
      const ids = jobIds(job);
      try {
        if (job.kind === 'game') {
          const outcome = await store.recordGame(job.input);
          this.pending.shift();
          log.info({ ...ids, outcome: outcome.kind, rated: isRated(job.input), attempts: item.attempts + 1 }, 'game result stored');
          if (outcome.kind === 'recorded' && outcome.ratings !== null) this.announce(job.input, outcome.ratings);
        } else {
          const outcome = await store.recordTournament(job.input);
          this.pending.shift();
          log.info({ ...ids, outcome: outcome.kind, attempts: item.attempts + 1 }, 'tournament result stored');
        }
      } catch (error) {
        item.attempts += 1;
        const unavailable = isUnavailable(error);
        const tooOld = clock.now() - item.queuedAt >= this.settings.maxAgeMs;
        if (tooOld || (!unavailable && item.attempts >= this.settings.maxErrorAttempts)) {
          this.pending.shift();
          log.error({ ...ids, attempts: item.attempts, err: errorName(error) }, 'game result dropped');
          continue;
        }
        const delay = Math.min(this.settings.maxDelayMs, this.settings.baseDelayMs * 2 ** (item.attempts - 1));
        log.warn(
          { ...ids, attempts: item.attempts, retryInMs: delay, pending: this.pending.length, err: errorName(error) },
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
