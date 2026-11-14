/**
 * The client's mirror of the server's per-player reaction limit (a token bucket: `burst`, then one
 * per `refillMs`). The server enforces the real limit; this only greys the picker out in time.
 */
export class ReactionBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly refillMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, t - this.last) / this.refillMs);
    this.last = t;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until a token is available (0 = now). */
  readyIn(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.refillMs);
  }
}
