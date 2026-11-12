import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { vi } from 'vitest';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

async function probeRedis(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/** Evaluated once per test file (top-level await). */
export const redisAvailable = await probeRedis(REDIS_URL);
if (!redisAvailable) {
  console.warn(`Redis not reachable at ${REDIS_URL} — skipping Redis tests (run docker-compose up -d)`);
}

/** Unique key prefix per test run, so parallel runs and real data never collide. */
export function testPrefix(): string {
  return `durak:test:${randomBytes(6).toString('hex')}:`;
}

export function newRedisClient(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
}

export function spyLogger() {
  return { error: vi.fn(), info: vi.fn() };
}
