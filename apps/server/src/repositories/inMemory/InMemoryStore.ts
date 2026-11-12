/**
 * Key/value store that deep-copies on every read and write, mimicking the
 * serialization boundary of Redis: callers can never mutate stored data by aliasing.
 */
export class InMemoryStore<T> {
  private readonly data = new Map<string, T>();

  get(key: string): T | null {
    const value = this.data.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  set(key: string, value: T): void {
    this.data.set(key, structuredClone(value));
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  get size(): number {
    return this.data.size;
  }
}
