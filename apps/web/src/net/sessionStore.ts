/** The subset of the Web Storage API we use (injectable for tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'durak:sessions';

/**
 * Session tokens by room id.
 *
 * Backed by `sessionStorage`, NOT `localStorage`: it is per tab and survives a reload, so two tabs
 * (or two people sharing a browser) are two separate seats. Trade-off: closing the tab forgets the
 * token, and that seat is forfeited once the server's reconnection grace window expires.
 */
export class SessionTokens {
  constructor(private readonly storage: KeyValueStorage | null) {}

  get(roomId: string): string | null {
    return this.read()[roomId] ?? null;
  }

  set(roomId: string, token: string): void {
    this.write({ ...this.read(), [roomId]: token });
  }

  remove(roomId: string): void {
    const { [roomId]: _removed, ...rest } = this.read();
    this.write(rest);
  }

  private read(): Record<string, string> {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return {};
    }
  }

  private write(map: Record<string, string>): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(map));
    } catch {
      // Storage blocked or full: the session simply won't survive a reload.
    }
  }
}

/** In-memory storage (tests, or when the browser blocks sessionStorage). */
export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function browserSessionStorage(): KeyValueStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
