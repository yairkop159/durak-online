import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPrismaClient, type PrismaClient } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrate.js';

export const POSTGRES_URL = process.env.DATABASE_URL ?? 'postgresql://durak:durak@127.0.0.1:5432/durak';

async function probePostgres(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Evaluated once per test file (top-level await). */
export const postgresAvailable = await probePostgres(POSTGRES_URL);
if (!postgresAvailable) {
  console.warn(`Postgres not reachable at ${POSTGRES_URL} — skipping Postgres tests (run docker-compose up -d)`);
}

/** POSTGRES_URL pointed at another schema (`?schema=`; Prisma's migrate engine and our adapter both honor it). */
export function urlWithSchema(schema: string): string {
  const url = new URL(POSTGRES_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export interface TestDatabase {
  readonly url: string;
  readonly schema: string;
  readonly prisma: PrismaClient;
  /** Raw SQL in this schema (assertions that must not go through the code under test). */
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

/**
 * A fresh, migrated schema per suite (`t_<random>`), so suites and real data never collide.
 * Migrations run through the real `prisma migrate deploy`.
 */
export async function freshDatabase(): Promise<TestDatabase> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const url = urlWithSchema(schema);
  await runMigrations(url);
  const prisma = createPrismaClient(url);
  const raw = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
  raw.on('error', () => undefined);
  return {
    url,
    schema,
    prisma,
    async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
      const client = await raw.connect();
      try {
        await client.query(`SET search_path TO "${schema}"`);
        return (await client.query<T>(sql, params)).rows;
      } finally {
        client.release();
      }
    },
    async drop() {
      await prisma.$disconnect().catch(() => undefined);
      await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await raw.end().catch(() => undefined);
    },
  };
}

/** A Postgres URL nothing listens on (outage tests). */
export const DEAD_POSTGRES_URL = 'postgresql://durak:secret-pw@127.0.0.1:1/durak';
