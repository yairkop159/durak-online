/** Abuse limits. All in-process: the server runs as a single instance (see CLAUDE.md). */
import { TokenBucket } from '../services/tokenBucket.js';

export { TokenBucket };
export interface LimitSettings {
  /** Token bucket per socket: burst capacity... */
  readonly eventBurst: number;
  /** ...refilled at this many events per second (sustained rate). */
  readonly eventsPerSecond: number;
  /** A socket that has this many events dropped within 10 s is disconnected. */
  readonly dropsBeforeDisconnect: number;
  /** Rooms one client IP may create per rolling hour. */
  readonly roomsPerIpPerHour: number;
  /** Rooms stored at once (lobby, playing or finished-but-not-expired). */
  readonly maxRooms: number;
  /** Open Socket.io connections per client IP. */
  readonly socketsPerIp: number;
}

export const DEFAULT_LIMITS: LimitSettings = {
  eventBurst: 20,
  eventsPerSecond: 10,
  dropsBeforeDisconnect: 100,
  roomsPerIpPerHour: 30,
  maxRooms: 500,
  socketsPerIp: 20,
};

/** No limits at all (test harnesses that drive many events without advancing the fake clock). */
export const UNLIMITED: LimitSettings = {
  eventBurst: Number.POSITIVE_INFINITY,
  eventsPerSecond: Number.POSITIVE_INFINITY,
  dropsBeforeDisconnect: Number.POSITIVE_INFINITY,
  roomsPerIpPerHour: Number.POSITIVE_INFINITY,
  maxRooms: Number.POSITIVE_INFINITY,
  socketsPerIp: Number.POSITIVE_INFINITY,
};

/**
 * At most `limit` hits per key within a rolling `windowMs`. Keeps only timestamps inside the
 * window, and sweeps idle keys once the map grows, so memory stays bounded by active keys.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sweepAbove = 10_000,
  ) {}

  /** Whether one more hit would be allowed (does not record it). */
  canHit(key: string): boolean {
    return this.recent(key).length < this.limit;
  }

  record(key: string): void {
    if (this.limit === Number.POSITIVE_INFINITY) return;
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > this.sweepAbove) this.sweep();
  }

  /** Diagnostics for tests. */
  get size(): number {
    return this.hits.size;
  }

  private recent(key: string): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = this.now() - this.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  private sweep(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}

/** Open connections per key (client IP). */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {}

  canOpen(key: string): boolean {
    return (this.counts.get(key) ?? 0) < this.limit;
  }

  open(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  close(key: string): void {
    const next = (this.counts.get(key) ?? 0) - 1;
    if (next <= 0) this.counts.delete(key);
    else this.counts.set(key, next);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/**
 * Per-socket event limiter: a token bucket, plus a drop counter over fixed 10 s windows so a
 * client that keeps flooding is disconnected instead of being answered forever.
 */
export class SocketEventLimiter {
  private readonly bucket: TokenBucket;
  private windowStart: number;
  private drops = 0;
  private lastNotice = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limits: LimitSettings,
    private readonly now: () => number,
  ) {
    this.bucket = new TokenBucket(limits.eventBurst, limits.eventsPerSecond, now);
    this.windowStart = now();
  }

  /**
   * 'allow' → handle the event. 'drop' → ignore it; `notify` says whether to tell the client
   * (at most once per second, so the error replies can't become a flood of their own).
   * 'disconnect' → too many drops in this window.
   */
  check(): { readonly verdict: 'allow' } | { readonly verdict: 'drop'; readonly notify: boolean } | { readonly verdict: 'disconnect' } {
    if (this.bucket.tryTake()) return { verdict: 'allow' };
    const t = this.now();
    if (t - this.windowStart >= 10_000) {
      this.windowStart = t;
      this.drops = 0;
    }
    this.drops++;
    if (this.drops >= this.limits.dropsBeforeDisconnect) return { verdict: 'disconnect' };
    const notify = t - this.lastNotice >= 1000;
    if (notify) this.lastNotice = t;
    return { verdict: 'drop', notify };
  }
}
