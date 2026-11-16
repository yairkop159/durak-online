import { describe, expect, it, vi } from 'vitest';
import type { GameResultInput } from '../src/ratings/gameResult.js';
import { RatingsUnavailableError, type RecordOutcome, type ResultStore } from '../src/ratings/ports.js';
import { ResultQueue } from '../src/ratings/ResultQueue.js';
import { FakeTime } from './helpers/fakeTime.js';

const input = (gameId: string): GameResultInput => ({
  gameId,
  roomId: 'room1',
  mode: 'podkidnoy',
  startedAt: 1,
  endedAt: 2,
  endReason: 'normal',
  durakId: null,
  seats: [],
});

function setup(store: ResultStore, settings = {}, onRecorded?: ConstructorParameters<typeof ResultQueue>[0]['onRecorded']) {
  const time = new FakeTime();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const queue = new ResultQueue({ store, clock: time, scheduler: time, log, settings, ...(onRecorded ? { onRecorded } : {}) });
  return { time, log, queue };
}

describe('ResultQueue', () => {
  it('writes in order, one at a time, and ignores a game already queued', async () => {
    const seen: string[] = [];
    let inFlight = 0;
    const store: ResultStore = {
      async recordGame(i) {
        inFlight++;
        expect(inFlight).toBe(1);
        await Promise.resolve();
        seen.push(i.gameId);
        inFlight--;
        return { kind: 'recorded', ratings: null };
      },
    };
    const { queue, time } = setup(store);
    queue.enqueue(input('a'));
    queue.enqueue(input('b'));
    queue.enqueue(input('b'));
    await time.advanceBy(0);
    expect(seen).toEqual(['a', 'b']);
  });

  it('a bug-type error (not an outage) is retried a few times, then dropped so it never blocks the queue', async () => {
    const store: ResultStore = {
      recordGame: vi.fn(async (i: GameResultInput) => {
        if (i.gameId === 'bad') throw new Error('constraint violated');
        return { kind: 'recorded', ratings: null } as const;
      }),
    };
    const { queue, time, log } = setup(store);
    queue.enqueue(input('bad'));
    queue.enqueue(input('good'));
    await time.advanceBy(60_000);
    expect(queue.size).toBe(0);
    expect(store.recordGame).toHaveBeenCalledTimes(4); // bad ×3, good ×1
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'bad', attempts: 3 }), 'game result dropped');
  });

  it('stays bounded: beyond maxSize the oldest result is dropped and logged', async () => {
    const store: ResultStore = { recordGame: async () => Promise.reject(new RatingsUnavailableError()) };
    const { queue, log } = setup(store, { maxSize: 2 });
    queue.enqueue(input('a'));
    queue.enqueue(input('b'));
    queue.enqueue(input('c'));
    expect(queue.size).toBe(2);
    expect(log.error).toHaveBeenCalledWith({ gameId: 'a' }, 'game result dropped: result queue full');
  });

  it('kick() retries at once (the database came back) instead of waiting for the backoff', async () => {
    let down = true;
    const store: ResultStore = { recordGame: async () => (down ? Promise.reject(new RatingsUnavailableError()) : { kind: 'recorded', ratings: null }) };
    const { queue, time } = setup(store, { baseDelayMs: 60_000 });
    queue.enqueue(input('a'));
    await time.advanceBy(0);
    expect(queue.size).toBe(1);
    down = false;
    queue.kick();
    await time.advanceBy(0);
    expect(queue.size).toBe(0);
    expect(time.pending).toHaveLength(0);
  });

  it('logs game ids only, never anything from the error message', async () => {
    const store: ResultStore = { recordGame: async () => Promise.reject(Object.assign(new Error('value secret-123'), { code: 'P1001' })) };
    const { queue, time, log } = setup(store);
    queue.enqueue(input('a'));
    await time.advanceBy(0);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-123');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'a', err: 'Error P1001' }), 'game result not stored yet: postgres unavailable');
  });

  describe('onRecorded (the rating announcement)', () => {
    const entries = [
      { playerId: 'a', before: 1000, after: 1016, delta: 16 },
      { playerId: 'b', before: 1000, after: 984, delta: -16 },
    ];

    it('fires once for a rated write that this queue committed; never for a duplicate or an unrated game', async () => {
      const outcomes: Record<string, RecordOutcome> = {
        rated: { kind: 'recorded', ratings: entries },
        unrated: { kind: 'recorded', ratings: null },
        dup: { kind: 'duplicate' },
      };
      const onRecorded = vi.fn();
      const { queue, time } = setup({ recordGame: async (i) => outcomes[i.gameId]! }, {}, onRecorded);
      for (const id of ['rated', 'unrated', 'dup']) queue.enqueue(input(id));
      await time.advanceBy(0);
      expect(onRecorded).toHaveBeenCalledTimes(1);
      expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'rated' }), entries);
    });

    it('fires only after the write that finally succeeds (not on the failed attempts)', async () => {
      let down = true;
      const onRecorded = vi.fn();
      const store: ResultStore = {
        recordGame: async () => (down ? Promise.reject(new RatingsUnavailableError()) : { kind: 'recorded', ratings: entries }),
      };
      const { queue, time } = setup(store, {}, onRecorded);
      queue.enqueue(input('a'));
      await time.advanceBy(10_000);
      expect(onRecorded).not.toHaveBeenCalled();
      down = false;
      await time.advanceBy(60_000);
      expect(onRecorded).toHaveBeenCalledTimes(1);
    });

    it('a failing or slow announcement never blocks or breaks the queue (logged by name only)', async () => {
      const onRecorded = vi.fn(async (i: GameResultInput) => {
        if (i.gameId === 'a') throw new Error('secret-xyz');
        return new Promise<void>(() => undefined); // never settles
      });
      const store: ResultStore = { recordGame: async () => ({ kind: 'recorded', ratings: entries }) };
      const { queue, time, log } = setup(store, {}, onRecorded);
      for (const id of ['a', 'b', 'c']) queue.enqueue(input(id));
      await time.advanceBy(0);
      expect(queue.size).toBe(0);
      expect(onRecorded).toHaveBeenCalledTimes(3);
      expect(log.error).toHaveBeenCalledWith({ gameId: 'a', err: 'Error' }, 'rating announcement failed');
      expect(JSON.stringify(log.error.mock.calls)).not.toContain('secret-xyz');
    });
  });
});
