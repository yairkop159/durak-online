import { describe, expect, it } from 'vitest';
import {
  ConnectionCounter,
  DEFAULT_LIMITS,
  SlidingWindowLimiter,
  SocketEventLimiter,
  TokenBucket,
  UNLIMITED,
} from '../src/transport/rateLimit.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const takeN = (bucket: TokenBucket, n: number) =>
  Array.from({ length: n }, () => bucket.tryTake()).filter(Boolean).length;

describe('TokenBucket', () => {
  it('allows a full burst, then refuses', () => {
    const c = clock();
    const bucket = new TokenBucket(20, 10, c.now);
    expect(takeN(bucket, 25)).toBe(20);
  });

  it('refills at the sustained rate, never above capacity', () => {
    const c = clock();
    const bucket = new TokenBucket(20, 10, c.now);
    takeN(bucket, 20);
    c.advance(1000);
    expect(takeN(bucket, 20)).toBe(10);
    c.advance(100);
    expect(takeN(bucket, 5)).toBe(1);
    c.advance(60_000);
    expect(takeN(bucket, 50)).toBe(20);
  });

  it('a steady 10/s client is never limited', () => {
    const c = clock();
    const bucket = new TokenBucket(20, 10, c.now);
    for (let i = 0; i < 1000; i++) {
      expect(bucket.tryTake()).toBe(true);
      c.advance(100);
    }
  });

  it('ignores a clock that goes backwards', () => {
    const c = clock();
    const bucket = new TokenBucket(2, 1, c.now);
    takeN(bucket, 2);
    c.advance(-5000);
    expect(bucket.tryTake()).toBe(false);
  });

  it('an infinite bucket always allows', () => {
    const bucket = new TokenBucket(Infinity, Infinity, clock().now);
    expect(takeN(bucket, 10_000)).toBe(10_000);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per key within the window, then frees them as they age out', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.canHit('a')).toBe(true);
      limiter.record('a');
      c.advance(10_000);
    }
    expect(limiter.canHit('a')).toBe(false);
    expect(limiter.canHit('b')).toBe(true); // per key
    c.advance(30_001); // the first hit is now older than 60 s
    expect(limiter.canHit('a')).toBe(true);
  });

  it('canHit does not record', () => {
    const limiter = new SlidingWindowLimiter(1, 1000, clock().now);
    for (let i = 0; i < 5; i++) expect(limiter.canHit('a')).toBe(true);
  });

  it('forgets idle keys, so memory is bounded by active keys', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(5, 1000, c.now, 100);
    for (let i = 0; i < 100; i++) limiter.record(`ip${i}`);
    expect(limiter.size).toBe(100);
    c.advance(2000);
    limiter.record('fresh'); // 101 keys > 100: sweep drops the expired ones
    expect(limiter.size).toBe(1);
  });
});

describe('ConnectionCounter', () => {
  it('counts open connections per key', () => {
    const counter = new ConnectionCounter(2);
    counter.open('a');
    expect(counter.canOpen('a')).toBe(true);
    counter.open('a');
    expect(counter.canOpen('a')).toBe(false);
    expect(counter.canOpen('b')).toBe(true);
    counter.close('a');
    expect(counter.canOpen('a')).toBe(true);
    counter.close('a');
    counter.close('a'); // never negative
    expect(counter.count('a')).toBe(0);
  });
});

describe('SocketEventLimiter', () => {
  it('drops past the burst, notifies at most once per second, then disconnects a flood', () => {
    const c = clock();
    const limiter = new SocketEventLimiter({ ...DEFAULT_LIMITS, dropsBeforeDisconnect: 50 }, c.now);
    const verdicts = Array.from({ length: 30 }, () => limiter.check());
    expect(verdicts.filter((v) => v.verdict === 'allow')).toHaveLength(20);
    const drops = verdicts.filter((v) => v.verdict === 'drop');
    expect(drops).toHaveLength(10);
    expect(drops.filter((v) => v.verdict === 'drop' && v.notify)).toHaveLength(1);

    c.advance(1000); // 10 tokens back
    const next = Array.from({ length: 15 }, () => limiter.check());
    expect(next.filter((v) => v.verdict === 'allow')).toHaveLength(10);
    expect(next.filter((v) => v.verdict === 'drop' && v.notify)).toHaveLength(1);

    // 15 drops so far in this 10 s window; the 50th one disconnects.
    let count = 0;
    let verdict = limiter.check();
    count++;
    while (verdict.verdict !== 'disconnect') {
      verdict = limiter.check();
      count++;
    }
    expect(count).toBe(35);
  });

  it('the drop count restarts every 10 s, so an occasional burst never disconnects', () => {
    const c = clock();
    const limiter = new SocketEventLimiter({ ...DEFAULT_LIMITS, dropsBeforeDisconnect: 10 }, c.now);
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 29; i++) expect(limiter.check().verdict).not.toBe('disconnect'); // 20 allowed + 9 drops
      c.advance(10_000);
    }
  });

  it('UNLIMITED never drops', () => {
    const limiter = new SocketEventLimiter(UNLIMITED, clock().now);
    for (let i = 0; i < 10_000; i++) expect(limiter.check().verdict).toBe('allow');
  });
});
