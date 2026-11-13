export type Clock = () => number;

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Key/value store that deep-copies on every read and write and expires entries,
 * mimicking Redis: callers can never mutate stored data by aliasing, and nothing lives forever.
 */
export class InMemoryStore<T> {
  private readonly data = new Map<string, Entry<T>>();

  constructor(private readonly now: Clock = Date.now) {}

  get(key: string): T | null {
    const entry = this.live(key);
    return entry ? structuredClone(entry.value) : null;
  }

  /** Like Redis GETEX: returns the value and resets its TTL. */
  getAndTouch(key: string, ttlSeconds: number): T | null {
    const entry = this.live(key);
    if (!entry) return null;
    this.data.set(key, { value: entry.value, expiresAt: this.now() + ttlSeconds * 1000 });
    return structuredClone(entry.value);
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.data.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlSeconds * 1000 });
  }

  /** Resets the TTL of an existing key; no-op if missing. */
  touch(key: string, ttlSeconds: number): void {
    const entry = this.live(key);
    if (entry) this.data.set(key, { value: entry.value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  /** Keys of entries that have not expired. */
  keys(): string[] {
    return [...this.data.keys()].filter((key) => this.live(key) !== undefined);
  }

  /** Remaining TTL in seconds, or null if the key does not exist (diagnostics/tests). */
  ttlSeconds(key: string): number | null {
    const entry = this.live(key);
    return entry ? Math.ceil((entry.expiresAt - this.now()) / 1000) : null;
  }

  private live(key: string): Entry<T> | undefined {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }
}
