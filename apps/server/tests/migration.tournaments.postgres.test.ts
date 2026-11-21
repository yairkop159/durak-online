/**
 * The tournaments migration on a database that already holds Phase 10 AND team-mode data: a schema
 * migrated up to team_mode only, filled with profiles, a rated classic game and a rated 2v2 game
 * (with a teamLoss seat) through raw SQL, then upgraded with the real `prisma migrate deploy`.
 * Every old row must survive untouched, `tournaments_won` must default to 0, `migrate status` must
 * be clean, and the real tournament write must work afterwards (idempotent by tournamentId).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/db/database.js';
import { runMigrations, SERVER_ROOT } from '../src/db/migrate.js';
import { PrismaResultStore } from '../src/ratings/PrismaResultStore.js';
import type { TournamentResultInput, TournamentResultSeat } from '../src/ratings/tournamentResult.js';
import { POSTGRES_URL, postgresAvailable, urlWithSchema } from './helpers/postgres.js';

const PHASE_10 = '20261114000000_profiles_games_ratings';
const TEAM_MODE = '20261120000000_team_mode';
const TOURNAMENTS = '20261121000000_tournaments';
const suite = postgresAvailable ? describe : describe.skip;

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

suite('migration upgrade path: tournaments on a database with Phase 10 + team-mode data (real Postgres)', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'durak-upgrade-'));
    cpSync(join(SERVER_ROOT, 'prisma', 'schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(SERVER_ROOT, 'prisma', 'migrations', 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
    for (const m of [PHASE_10, TEAM_MODE]) {
      cpSync(join(SERVER_ROOT, 'prisma', 'migrations', m), join(dir, 'migrations', m), { recursive: true });
    }
    writeFileSync(
      join(dir, 'prisma.config.ts'),
      "export default { schema: 'schema.prisma', migrations: { path: 'migrations' }, datasource: { url: process.env.DATABASE_URL ?? '' } };\n",
    );
    const deployed = await prismaCli(['migrate', 'deploy'], dir, url);
    if (deployed.code !== 0) throw new Error(`team_mode deploy failed: ${deployed.output}`);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await raw?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await raw?.end().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every old row, defaults tournaments_won to 0, and the tournament write works after', async () => {
    const before = await q<{ migration_name: string }>('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
    expect(before.map((r) => r.migration_name)).toEqual([PHASE_10, TEAM_MODE]);
    expect(await q("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'tournaments'", [schema])).toEqual([]);

    // Phase 10 + team-mode data, with the columns of that schema exactly.
    for (const [id, rating] of [['pa', 1024], ['pb', 976], ['pc', 1008], ['pd', 992]] as const) {
      await q(
        `INSERT INTO profiles (id, nickname, device_key_hash, rating, games, rated_games, wins, duraks, forfeits, updated_at)
         VALUES ($1, $2, $3, $4, 2, 2, 1, 1, 0, now())`,
        [id, `N-${id}`, `hash-${id}`, rating],
      );
    }
    await q(
      `INSERT INTO games (id, room_id, mode, teams, player_count, end_reason, rated, bot_assisted, durak_profile_id, started_at, ended_at)
       VALUES ('classic1', 'room1', 'podkidnoy', false, 2, 'normal', true, false, 'pb', now(), now()),
              ('team1', 'room2', 'perevodnoy', true, 4, 'normal', true, false, 'pb', now(), now())`,
    );
    const seats: [string, number, string, string][] = [
      ['classic1', 0, 'pa', 'win'],
      ['classic1', 1, 'pb', 'durak'],
      ['team1', 0, 'pa', 'win'],
      ['team1', 1, 'pb', 'durak'],
      ['team1', 2, 'pc', 'win'],
      ['team1', 3, 'pd', 'teamLoss'],
    ];
    for (const [gameId, seat, profileId, result] of seats) {
      await q(
        `INSERT INTO game_players (game_id, seat, profile_id, nickname, is_bot, result, rating_before, rating_after, forfeited, bot_assisted)
         VALUES ($1, $2, $3, $3, false, $4::player_result, 1000, 1000, false, false)`,
        [gameId, seat, profileId, result],
      );
    }
    const snapshot = async () => ({
      profiles: await q(
        'SELECT id, nickname, device_key_hash, transfer_code_hash, transfer_expires_at, rating, games, rated_games, wins, duraks, forfeits, created_at, updated_at FROM profiles ORDER BY id',
      ),
      games: await q('SELECT * FROM games ORDER BY id'),
      players: await q('SELECT game_id, seat, profile_id, nickname, is_bot, result::text AS result, rating_before, rating_after, forfeited, bot_assisted FROM game_players ORDER BY game_id, seat'),
    });
    const old = await snapshot();

    await runMigrations(url);
    expect(await snapshot()).toEqual(old);
    expect(await q('SELECT id, tournaments_won FROM profiles ORDER BY id')).toEqual(
      ['pa', 'pb', 'pc', 'pd'].map((id) => ({ id, tournaments_won: 0 })),
    );
    const applied = await q<{ migration_name: string }>('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
    expect(applied.map((r) => r.migration_name)).toEqual([PHASE_10, TEAM_MODE, TOURNAMENTS]);
    const status = await prismaCli(['migrate', 'status'], SERVER_ROOT, url);
    expect(status.code, status.output).toBe(0);
    expect(status.output).toContain('Database schema is up to date');

    // The real write path: a 2v2 series won by pa + pc, a left seat and a bot never credited.
    prisma = createPrismaClient(url);
    const store = new PrismaResultStore(() => prisma);
    const seat = (i: number, profileId: string | null, over: Partial<TournamentResultSeat> = {}): TournamentResultSeat => ({
      seat: i,
      playerId: `p${i}`,
      profileId,
      nickname: `N${i}`,
      isBot: false,
      left: false,
      points: i % 2 === 0 ? 2.5 : 0.5,
      duraks: i % 2 === 0 ? 0 : 2,
      rank: i % 2 === 0 ? 1 : 2,
      champion: i % 2 === 0,
      credited: i % 2 === 0,
      ...over,
    });
    const input: TournamentResultInput = {
      tournamentId: 'tour1',
      roomId: 'room3',
      mode: 'podkidnoy',
      teams: true,
      gamesPlanned: 3,
      gamesPlayed: 3,
      status: 'finished',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_003_600_000,
      seats: [seat(0, 'pa'), seat(1, 'pb', { left: true }), seat(2, 'pc'), seat(3, null, { isBot: true, nickname: 'Bot 1' })],
    };
    expect(await store.recordTournament(input)).toEqual({ kind: 'recorded' });
    expect(await store.recordTournament(input)).toEqual({ kind: 'duplicate' });
    expect(await q('SELECT id, tournaments_won FROM profiles ORDER BY id')).toEqual([
      { id: 'pa', tournaments_won: 1 },
      { id: 'pb', tournaments_won: 0 },
      { id: 'pc', tournaments_won: 1 },
      { id: 'pd', tournaments_won: 0 },
    ]);
    expect(await q("SELECT teams, status, games_played FROM tournaments WHERE id = 'tour1'")).toEqual([
      { teams: true, status: 'finished', games_played: 3 },
    ]);
    expect(await q("SELECT seat, profile_id, is_bot, \"left\", points, champion FROM tournament_players WHERE tournament_id = 'tour1' ORDER BY seat")).toEqual([
      { seat: 0, profile_id: 'pa', is_bot: false, left: false, points: 2.5, champion: true },
      { seat: 1, profile_id: 'pb', is_bot: false, left: true, points: 0.5, champion: false },
      { seat: 2, profile_id: 'pc', is_bot: false, left: false, points: 2.5, champion: true },
      { seat: 3, profile_id: null, is_bot: true, left: false, points: 0.5, champion: false },
    ]);
    // Old rows are still untouched after the new write.
    expect((await snapshot()).games).toEqual(old.games);
  }, 120_000);
});
