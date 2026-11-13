import type { ClientMove } from '@durak/shared';
import { decide, fallbackDecision } from './decide.js';
import type { BotJob, BotRunner } from './job.js';

/**
 * Runs decisions synchronously on the calling thread. Used by tests (with small iteration budgets,
 * so results are deterministic) and as a fallback when worker threads are unavailable.
 */
export class InProcessRunner implements BotRunner {
  /** Every job this runner received, serialized exactly as a worker would receive it (tests). */
  readonly serializedJobs: string[] = [];

  constructor(
    private readonly options: { readonly now?: () => number; readonly recordJobs?: boolean } = {},
  ) {}

  run(job: BotJob, signal: AbortSignal): Promise<ClientMove | null> {
    if (this.options.recordJobs) this.serializedJobs.push(JSON.stringify(job));
    if (signal.aborted) return Promise.resolve(null);
    try {
      return Promise.resolve(decide(job, this.options.now ?? (() => performance.now())));
    } catch {
      return Promise.resolve(fallbackDecision(job));
    }
  }

  async dispose(): Promise<void> {}
}
