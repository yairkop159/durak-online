import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Clock, Scheduler, TimerHandle } from '../services/scheduling.js';
import { redactUrl, runMigrations } from './migrate.js';

export type { PrismaClient };

/**
 * Postgres (Phase 10) is optional: profiles, history and ratings live there, games never depend
 * on it.
 * - disabled: no DATABASE_URL;
 * - down: configured but not reachable (or migrations failed) — retried in the background;
 * - ok: migrated and connected.
 */
export type DbStatus = 'disabled' | 'down' | 'ok';

export interface DbLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface Database {
  readonly configured: boolean;
  /** The client once migrations ran and a first query succeeded; null while disabled or down. */
  client(): PrismaClient | null;
  /** First connection attempt; on failure, retries every `retryMs` (default 15 s). Never throws. */
  start(): Promise<void>;
  /** Called each time the database becomes ready (first start or a later retry). */
  onReady(listener: () => void): void;
  health(): Promise<DbStatus>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly url: string | null;
  readonly migrateOnStart: boolean;
  readonly log: DbLogger;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly retryMs?: number;
  /** Injected for tests; defaults to `prisma migrate deploy`. */
  readonly migrate?: (url: string) => Promise<unknown>;
  /** Injected for tests; defaults to a Prisma client over @prisma/adapter-pg. */
  readonly connect?: (url: string) => PrismaClient;
}

/**
 * `?schema=name` selects a Postgres schema (tests use one per suite). Prisma's migrate engine
 * reads it from the URL; the pg adapter takes it as an option, so it is split off here.
 */
export function parseDatabaseUrl(url: string): { connectionString: string; schema: string | undefined } {
  const parsed = new URL(url);
  const schema = parsed.searchParams.get('schema') ?? undefined;
  parsed.searchParams.delete('schema');
  return { connectionString: parsed.toString(), schema };
}

export function createPrismaClient(url: string): PrismaClient {
  const { connectionString, schema } = parseDatabaseUrl(url);
  const adapter = new PrismaPg(
    { connectionString, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 300_000, max: 5 },
    schema !== undefined ? { schema } : undefined,
  );
  return new PrismaClient({ adapter });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref()),
  ]);
}

export const DB_RETRY_MS = 15_000;

export function createDatabase(options: DatabaseOptions): Database {
  const { url, log } = options;
  const retryMs = options.retryMs ?? DB_RETRY_MS;
  const migrate = options.migrate ?? ((u: string) => runMigrations(u));
  const connect = options.connect ?? createPrismaClient;
  let client: PrismaClient | null = null;
  let retry: TimerHandle | null = null;
  let closed = false;
  let attempting = false;
  const listeners: Array<() => void> = [];

  async function attempt(): Promise<void> {
    if (url === null || closed || client !== null || attempting) return;
    attempting = true;
    let candidate: PrismaClient | null = null;
    try {
      if (options.migrateOnStart) {
        await migrate(url);
        log.info({}, 'postgres migrations applied');
      }
      candidate = connect(url);
      await withTimeout(candidate.$queryRaw`SELECT 1`, 5_000, 'postgres connect');
      if (closed) {
        await candidate.$disconnect();
        return;
      }
      client = candidate;
      log.info({}, 'postgres ready: profiles and ratings on');
      for (const listener of listeners) listener();
    } catch (error) {
      if (candidate) await candidate.$disconnect().catch(() => {});
      const message = redactUrl(error instanceof Error ? error.message : String(error), url);
      log.warn({ err: message, retryInMs: retryMs }, 'postgres unavailable: games run, ratings are off');
      if (!closed) {
        retry = options.scheduler.schedule(options.clock.now() + retryMs, async () => {
          retry = null;
          await attempt();
        });
      }
    } finally {
      attempting = false;
    }
  }

  return {
    configured: url !== null,
    client: () => client,
    start: attempt,
    onReady(listener) {
      listeners.push(listener);
    },
    async health() {
      if (url === null) return 'disabled';
      if (client === null) return 'down';
      try {
        await withTimeout(client.$queryRaw`SELECT 1`, 1_000, 'postgres ping');
        return 'ok';
      } catch {
        return 'down';
      }
    },
    async close() {
      closed = true;
      if (retry) options.scheduler.cancel(retry);
      retry = null;
      const current = client;
      client = null;
      if (current) await current.$disconnect().catch(() => {});
    },
  };
}
