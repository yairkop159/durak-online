import { Redis } from 'ioredis';
import type { RepositoryKind } from './config.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories } from './repositories/inMemory/index.js';
import {
  createRedisRepositories,
  markAllMembersDisconnected,
  redisKeys,
  type RepoLogger,
} from './repositories/redis/index.js';

export interface HealthReport {
  readonly ok: boolean;
  readonly repository: RepositoryKind;
  readonly redis?: 'PONG' | 'down';
}

/** Storage backend plus its lifecycle hooks. */
export interface Backend {
  readonly kind: RepositoryKind;
  readonly repos: Repositories;
  /** One-time work before accepting connections (Redis: ghost-connection reset). */
  startup(): Promise<void>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

export interface BackendConfig {
  readonly repository: RepositoryKind;
  readonly redisUrl: string | null;
  readonly redisPrefix: string;
}

export interface BackendLogger extends RepoLogger {
  info(obj: object, msg: string): void;
}

export function createMemoryBackend(): Backend {
  return {
    kind: 'memory',
    repos: createInMemoryRepositories(),
    async startup() {},
    async health() {
      return { ok: true, repository: 'memory' };
    },
    async close() {},
  };
}

/** Connects eagerly and fails fast if Redis is unreachable. */
export async function createRedisBackend(url: string, prefix: string, log: BackendLogger): Promise<Backend & { redis: Redis }> {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 5000 });
  redis.on('error', (error: unknown) => log.error({ err: error }, 'redis connection error'));
  await redis.connect();
  const keys = redisKeys(prefix);

  return {
    kind: 'redis',
    redis,
    repos: createRedisRepositories(redis, keys, log),
    async startup() {
      const result = await markAllMembersDisconnected(redis, keys, log);
      log.info(result, 'reset ghost connections');
    },
    async health() {
      try {
        const pong = await Promise.race([
          redis.ping(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 1000).unref()),
        ]);
        return { ok: pong === 'PONG', repository: 'redis', redis: pong === 'PONG' ? 'PONG' : 'down' };
      } catch {
        return { ok: false, repository: 'redis', redis: 'down' };
      }
    },
    async close() {
      if (redis.status === 'end') return;
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

export async function createBackend(config: BackendConfig, log: BackendLogger): Promise<Backend> {
  if (config.repository === 'memory') return createMemoryBackend();
  if (!config.redisUrl) throw new Error('REPOSITORY=redis requires REDIS_URL');
  return createRedisBackend(config.redisUrl, config.redisPrefix, log);
}
