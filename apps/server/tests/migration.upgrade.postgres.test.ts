/**
 * The team_mode migration on a database that already holds Phase 10 data (not only on an empty
 * schema): a schema migrated up to the Phase 10 migration only, filled with profiles, a rated game
 * and every old seat result through raw SQL (the old columns exactly), then upgraded with the real
 * `prisma migrate deploy`. The old rows must survive untouched, `migrate status` must be clean, and
 * the new enum value must be usable afterwards (Postgres forbids using a value added by
 * `ALTER TYPE ... ADD VALUE` in the transaction that added it).
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db/database.js';
import { runMigrations, SERVER_ROOT } from '../src/db/migrate.js';
import type { GameResultInput, ResultSeat } from '../src/ratings/gameResult.js';
import { PrismaResultStore } from '../src/ratings/PrismaResultStore.js';
import { POSTGRES_URL, postgresAvailable, urlWithSchema } from './helpers/postgres.js';

const PHASE_10 = '20261114000000_profiles_games_ratings';
const suite = postgresAvailable ? describe : describe.skip;

/** Runs the Prisma CLI in `cwd` (which holds a prisma.config.ts) and resolves with exit code + output. */
function prismaCli(args: string[], cwd: string, url: string): Promise<{ code: number | null; output: string }> {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

suite('migration upgrade path: team_mode on a database with Phase 10 data (real Postgres)', () => {
  const schema = `t_upg_${randomBytes(5).toString('hex')}`;
  const url = urlWithSchema(schema);
  let dir = '';
  let raw: pg.Pool;
  let prisma: PrismaClient | null = null;

  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const client = await raw.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      return (await client.query<T>(sql, params)).rows;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    raw = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
    raw.on('error', () => undefined);
    // A migrations folder that stops at Phase 10, with a config of its own (no imports: it must load
    // from a temp folder outside the workspace).
    dir = mkdtempSync(join(tmpdir(), 'durak-upgrade-'));
    cpSync(join(SERVER_ROOT, 'prisma', 'schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(SERVER_ROOT, 'prisma', 'migrations', 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
    cpSync(join(SERVER_ROOT, 'prisma', 'migrations', PHASE_10), join(dir, 'migrations', PHASE_10), { recursive: true });
    writeFileSync(
      join(dir, 'prisma.config.ts'),
      "export default { schema: 'schema.prisma', migrations: { path: 'migrations' }, datasource: { url: process.env.DATABASE_URL ?? '' } };\n",
    );
    const phase10 = await prismaCli(['migrate', 'deploy'], dir, url);
    if (phase10.code !== 0) throw new Error(`Phase 10 deploy failed: ${phase10.output}`);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await raw?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await raw?.end().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every Phase 10 row, defaults games.teams to false, and the new value is usable after', async () => {
    // Only the Phase 10 migration is applied: no teams column yet.
    const before = await q<{ migration_name: string }>('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
    expect(before.map((r) => r.migration_name)).toEqual([PHASE_10]);
    expect(await q("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'games' AND column_name = 'teams'", [schema])).toEqual([]);

    // Phase 10 data, written with the old columns exactly.
    for (const [id, rating] of [['pa', 1016], ['pb', 984], ['pc', 1000]] as const) {
      await q(
        `INSERT INTO profiles (id, nickname, device_key_hash, rating, games, rated_games, wins, duraks, forfeits, updated_at)
         VALUES ($1, $2, $3, $4, 1, 1, $5, $6, 0, now())`,
        [id, `N-${id}`, `hash-${id}`, rating, id === 'pa' ? 1 : 0, id === 'pb' ? 1 : 0],
      );
    }
    await q(
      `INSERT INTO games (id, room_id, mode, player_count, end_reason, rated, bot_assisted, durak_profile_id, started_at, ended_at)
       VALUES ('old1', 'room1', 'podkidnoy', 6, 'normal', true, false, 'pb', now(), now())`,
    );
    const oldResults = ['win', 'durak', 'draw', 'forfeit', 'unfinished', 'win'];
    for (const [seat, result] of oldResults.entries()) {
      await q(
        `INSERT INTO game_players (game_id, seat, profile_id, nickname, is_bot, result, rating_before, rating_after, forfeited, bot_assisted)
         VALUES ('old1', $1, $2, $3, $4, $5::player_result, $6, $7, $8, false)`,
        [seat, seat < 3 ? ['pa', 'pb', 'pc'][seat] : null, `S${seat}`, seat >= 4, result, seat < 2 ? 1000 : null, seat === 0 ? 1016 : seat === 1 ? 984 : null, result === 'forfeit'],
      );
    }
    const snapshot = async () => ({
      // The Phase 10 columns exactly (later migrations add columns of their own).
      profiles: await q(
        'SELECT id, nickname, device_key_hash, transfer_code_hash, transfer_expires_at, rating, games, rated_games, wins, duraks, forfeits, created_at, updated_at FROM profiles ORDER BY id',
      ),
      games: await q('SELECT id, room_id, mode, player_count, end_reason, rated, bot_assisted, durak_profile_id, started_at, ended_at FROM games ORDER BY id'),
      players: await q('SELECT * FROM game_players ORDER BY game_id, seat'),
    });
    const old = await snapshot();

    // Upgrade with the real migrations folder (the server's startup path).
    await runMigrations(url);
    expect(await snapshot()).toEqual(old);
    expect(await q('SELECT id, teams FROM games')).toEqual([{ id: 'old1', teams: false }]);
    const status = await prismaCli(['migrate', 'status'], SERVER_ROOT, url);
    expect(status.code, status.output).toBe(0);
    expect(status.output).toContain('Database schema is up to date');

    // The new value works through the real write path: a rated 2v2 game with a teamLoss seat.
    for (const id of ['pd']) {
      await q(`INSERT INTO profiles (id, nickname, device_key_hash, updated_at) VALUES ($1, $1, $2, now())`, [id, `hash-${id}`]);
    }
    prisma = createPrismaClient(url);
    const store = new PrismaResultStore(() => prisma);
    const seat = (i: number, profileId: string): ResultSeat => ({
      seat: i,
      playerId: `p${i}`,
      nickname: `N${i}`,
      isBot: false,
      profileId,
      botAssisted: false,
      forfeited: false,
    });
    const input: GameResultInput = {
      gameId: 'team1',
      roomId: 'room2',
      mode: 'podkidnoy',
      teams: true,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_600_000,
      endReason: 'normal',
      durakId: 'p1',
      seats: [seat(0, 'pa'), seat(1, 'pb'), seat(2, 'pc'), seat(3, 'pd')],
    };
    const outcome = await store.recordGame(input);
    expect(outcome.kind).toBe('recorded');
    expect(await q("SELECT seat, result::text AS result FROM game_players WHERE game_id = 'team1' ORDER BY seat")).toEqual([
      { seat: 0, result: 'win' },
      { seat: 1, result: 'durak' },
      { seat: 2, result: 'win' },
      { seat: 3, result: 'teamLoss' },
    ]);
    expect(await q("SELECT teams, rated FROM games WHERE id = 'team1'")).toEqual([{ teams: true, rated: true }]);
  }, 120_000);
});
