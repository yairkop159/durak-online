import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase, parseDatabaseUrl, type PrismaClient } from '../src/db/database.js';
import { redactUrl, runMigrations } from '../src/db/migrate.js';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { FakeTime } from './helpers/fakeTime.js';
import { DEAD_POSTGRES_URL, freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

describe('database config', () => {
  it('DATABASE_URL is optional and must be a postgres URL', () => {
    expect(loadConfig({}).databaseUrl).toBeNull();
    expect(loadConfig({ DATABASE_URL: ' postgresql://u:p@h:5432/d ' }).databaseUrl).toBe('postgresql://u:p@h:5432/d');
    expect(loadConfig({ DATABASE_URL: 'postgres://h/d' }).databaseUrl).toBe('postgres://h/d');
    expect(() => loadConfig({ DATABASE_URL: 'mysql://u:hunter2@h/d' })).toThrow(/DATABASE_URL/);
    // The error never echoes the URL (it holds a password).
    expect(() => loadConfig({ DATABASE_URL: 'mysql://u:hunter2@h/d' })).not.toThrow(/hunter2/);
  });

  it('DB_MIGRATE_ON_START defaults to true', () => {
    expect(loadConfig({}).dbMigrateOnStart).toBe(true);
    expect(loadConfig({ DB_MIGRATE_ON_START: 'false' }).dbMigrateOnStart).toBe(false);
    expect(() => loadConfig({ DB_MIGRATE_ON_START: 'maybe' })).toThrow(/DB_MIGRATE_ON_START/);
  });

  it('?schema= is split off for the pg adapter', () => {
    expect(parseDatabaseUrl('postgresql://u:p@h:5432/d?schema=t_1&sslmode=disable')).toEqual({
      connectionString: 'postgresql://u:p@h:5432/d?sslmode=disable',
      schema: 't_1',
    });
    expect(parseDatabaseUrl('postgresql://h/d').schema).toBeUndefined();
  });

  it('redacts the password from messages', () => {
    expect(redactUrl('auth failed for secret-pw at host', DEAD_POSTGRES_URL)).toBe('auth failed for *** at host');
  });
});

describe('database lifecycle (injected migrate/connect)', () => {
  const fakeClient = (ok: () => boolean) =>
    ({
      $queryRaw: () => (ok() ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('ECONNREFUSED'))),
      $disconnect: vi.fn(async () => undefined),
    }) as unknown as PrismaClient;

  it('disabled without a URL: never connects', async () => {
    const connect = vi.fn();
    const db = createDatabase({ url: null, migrateOnStart: true, log: quietLog(), clock: new FakeTime(), scheduler: new FakeTime(), connect });
    await db.start();
    expect(connect).not.toHaveBeenCalled();
    expect(await db.health()).toBe('disabled');
    expect(db.client()).toBeNull();
  });

  it('down at startup: logs a redacted warning, retries, then becomes ready once', async () => {
    const time = new FakeTime();
    const log = quietLog();
    let up = false;
    const migrate = vi.fn(async () => {
      if (!up) throw new Error(`connect ECONNREFUSED for ${DEAD_POSTGRES_URL}`);
    });
    const ready = vi.fn();
    const db = createDatabase({
      url: DEAD_POSTGRES_URL,
      migrateOnStart: true,
      log,
      clock: time,
      scheduler: time,
      retryMs: 30_000,
      migrate,
      connect: () => fakeClient(() => up),
    });
    db.onReady(ready);
    await expect(db.start()).resolves.toBeUndefined();
    expect(await db.health()).toBe('down');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-pw');

    await time.advanceBy(30_000); // still down: one more warning, another retry
    expect(migrate).toHaveBeenCalledTimes(2);
    up = true;
    await time.advanceBy(30_000);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(await db.health()).toBe('ok');
    await time.advanceBy(120_000);
    expect(migrate).toHaveBeenCalledTimes(3); // no more retries once ready
    await db.close();
    expect(db.client()).toBeNull();
  });

  it('close() cancels a pending retry', async () => {
    const time = new FakeTime();
    const migrate = vi.fn(async () => Promise.reject(new Error('down')));
    const db = createDatabase({ url: DEAD_POSTGRES_URL, migrateOnStart: true, log: quietLog(), clock: time, scheduler: time, migrate });
    await db.start();
    await db.close();
    await time.advanceBy(10 * 60_000);
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});

describe('Postgres outage: /health stays 200', () => {
  it('a real client against a closed port reports postgres "down" and the server stays up', async () => {
    const time = new FakeTime();
    const db = createDatabase({ url: DEAD_POSTGRES_URL, migrateOnStart: false, log: quietLog(), clock: time, scheduler: time });
    await db.start();
    const server = buildServer({ database: db, botRunner: new InProcessRunner(), clock: time, scheduler: time });
    try {
      const res = await server.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, repository: 'memory', postgres: 'down' });
    } finally {
      await server.app.close();
    }
  });
});

const suite = postgresAvailable ? describe : describe.skip;

suite('Postgres migrations (real database)', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await freshDatabase();
  }, 60_000);
  afterAll(async () => tdb?.drop());

  it('creates the three tables in the selected schema', async () => {
    const rows = await tdb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [tdb.schema],
    );
    expect(rows.map((r) => r.table_name)).toEqual(['_prisma_migrations', 'game_players', 'games', 'profiles']);
  });

  it('migrate deploy is idempotent', async () => {
    await expect(runMigrations(tdb.url)).resolves.toMatch(/No pending migrations|applied/i);
  }, 60_000);

  it('the Prisma client (pg adapter) queries the selected schema', async () => {
    await tdb.prisma.profile.create({ data: { id: 'p'.repeat(22), nickname: 'Dana', deviceKeyHash: 'h1' } });
    expect(await tdb.prisma.profile.count()).toBe(1);
    expect((await tdb.query('SELECT rating FROM profiles'))[0]).toEqual({ rating: 1000 });
  });

  it('createDatabase migrates, connects and reports ok', async () => {
    const time = new FakeTime();
    const db = createDatabase({ url: tdb.url, migrateOnStart: true, log: quietLog(), clock: time, scheduler: time });
    await db.start();
    expect(await db.health()).toBe('ok');
    expect(await db.client()!.profile.count()).toBe(1);
    await db.close();
  }, 60_000);
});
