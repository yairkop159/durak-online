/**
 * Per-key async mutex: operations sharing a key run strictly one at a time, in FIFO order.
 * Operations on different keys run concurrently.
 *
 * Process-local only. With more than one server instance this must be backed by a
 * distributed lock (or rooms must be pinned to one instance) — see Phase 3b.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    // A failing operation must not poison the queue for the next one.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  /** Number of keys with queued or running work (for tests and diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
