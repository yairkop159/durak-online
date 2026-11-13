import type { Clock, Scheduler, TimerHandle } from '../../src/services/scheduling.js';

interface Task {
  readonly id: number;
  readonly seq: number;
  readonly at: number;
  readonly fn: () => Promise<void>;
}

/**
 * Deterministic clock + scheduler. Nothing runs until the test advances time, and
 * `advanceBy` awaits each fired callback, so no real sleeps are ever needed.
 */
export class FakeTime implements Clock, Scheduler {
  private current: number;
  private nextId = 1;
  private tasks: Task[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(at: number, fn: () => Promise<void>): TimerHandle {
    const id = this.nextId++;
    this.tasks.push({ id, seq: id, at, fn });
    return { id };
  }

  cancel(handle: TimerHandle): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle.id);
  }

  /** Moves time forward, running every due task in deadline order (including ones scheduled meanwhile). */
  async advanceBy(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      await due.fn();
    }
    this.current = target;
  }

  /** Runs tasks that are already due (e.g. deadlines that expired while the server was down). */
  runDue(): Promise<void> {
    return this.advanceBy(0);
  }

  /** Jumps the clock without running anything (simulates time passing while a server is down). */
  setNow(epochMs: number): void {
    this.current = epochMs;
  }

  get pending(): readonly { at: number }[] {
    return this.tasks.map((t) => ({ at: t.at }));
  }
}
