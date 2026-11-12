import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/services/KeyedMutex.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('runs 50 parallel operations on one key strictly one at a time, in FIFO order', async () => {
    const mutex = new KeyedMutex();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        mutex.runExclusive('room', async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await tick(i % 3);
          order.push(i);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
    await tick(0);
    expect(mutex.activeKeys).toBe(0);
  });

  it('a failing operation rejects its own caller but does not block the queue', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.runExclusive('room', async () => {
      throw new Error('boom');
    });
    const next = mutex.runExclusive('room', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    let running = 0;
    let maxRunning = 0;
    await Promise.all(
      ['a', 'b', 'c'].map((key) =>
        mutex.runExclusive(key, async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await tick(10);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(3);
  });
});
