import { describe, expect, it } from 'vitest';
import { remainingMs, secondsLeft } from '../src/net/clock';

describe('countdown math', () => {
  it('is deadline minus server time when just received', () => {
    expect(remainingMs({ turnDeadline: 31_000, serverTime: 1_000, receivedAt: 500 }, 500)).toBe(30_000);
  });

  it('ignores clock skew: the local clock may be hours off the server clock', () => {
    const local = 1_700_000_000_000;
    const game = { turnDeadline: 50_000, serverTime: 20_000, receivedAt: local };
    expect(remainingMs(game, local)).toBe(30_000);
    expect(remainingMs(game, local + 12_500)).toBe(17_500);
  });

  it('never goes below zero', () => {
    expect(remainingMs({ turnDeadline: 2_000, serverTime: 1_000, receivedAt: 0 }, 5_000)).toBe(0);
  });

  it('is null without a deadline', () => {
    expect(remainingMs({ turnDeadline: null, serverTime: 1_000, receivedAt: 0 }, 0)).toBeNull();
  });

  it('shows whole seconds rounded up', () => {
    expect(secondsLeft(30_000)).toBe(30);
    expect(secondsLeft(29_001)).toBe(30);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
  });
});
