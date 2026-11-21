import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LeaderboardResponse, PublicProfile } from '@durak/shared';
import { buildServer, type DurakServer } from '../src/app.js';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { createDatabase } from '../src/db/database.js';
import { UNLIMITED_API } from '../src/http/api.js';
import type { GameResultInput, ResultSeat } from '../src/ratings/gameResult.js';
import { PrismaProfileStore } from '../src/ratings/PrismaProfileStore.js';
import { PrismaResultStore } from '../src/ratings/PrismaResultStore.js';
import { FakeTime } from './helpers/fakeTime.js';
import { freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';

const suite = postgresAvailable ? describe : describe.skip;

const seat = (i: number, profileId: string | null, isBot = false): ResultSeat => ({
  seat: i,
  playerId: `p${i}`,
  nickname: isBot ? `Bot ${i}` : `N${i}`,
  isBot,
  profileId,
  botAssisted: false,
  forfeited: false,
});

suite('GET /api/leaderboard and /api/profile/:id (real Postgres)', () => {
  let tdb: TestDatabase;
  let server: DurakServer;
  const ids: string[] = [];
  let loner = '';
  let n = 0;
  const T0 = 1_700_000_000_000;

  beforeAll(async () => {
    tdb = await freshDatabase();
    const profiles = new PrismaProfileStore(() => tdb.prisma);
    const results = new PrismaResultStore(() => tdb.prisma);
    for (let i = 0; i < 23; i++) ids.push((await profiles.create(`P${String(i).padStart(2, '0')}`)).profileId);
    loner = (await profiles.create('Loner')).profileId; // only unrated games
    const record = (seats: ResultSeat[], durakId: string | null, over: Partial<GameResultInput> = {}) =>
      results.recordGame({
        gameId: `g${String(++n).padStart(3, '0')}`,
        roomId: 'room1',
        mode: 'perevodnoy',
        startedAt: T0 + n * 1000,
        endedAt: T0 + n * 60_000,
        endReason: 'normal',
        durakId,
        seats,
        ...over,
      });
    // A ladder: P00 beats everyone once, P01 everyone after it, ... (distinct ratings).
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j += 5) await record([seat(0, ids[i]!), seat(1, ids[j]!)], 'p1');
    }
    // 25 unrated games for P00 against a bot (the bot is the durak), so its recent list is capped.
    for (let k = 0; k < 25; k++) await record([seat(0, ids[0]!), seat(1, null, true)], 'p1');
    await record([seat(0, loner), seat(1, null, true)], 'p0'); // the loner is the durak

    const time = new FakeTime();
    const database = createDatabase({ url: tdb.url, migrateOnStart: false, log: { info: vi.fn(), warn: vi.fn() }, clock: time, scheduler: time });
    await database.start();
    server = buildServer({ database, clock: time, scheduler: time, botRunner: new InProcessRunner(), apiLimits: UNLIMITED_API });
  }, 120_000);
  afterAll(async () => {
    await server?.app.close();
    await tdb?.drop();
  });

  const get = async <T>(url: string) => {
    const res = await server.app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as T };
  };

  it('top 20 by rating (ties by id), only profiles with a rated game', async () => {
    const { status, body } = await get<LeaderboardResponse>('/api/leaderboard');
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(20);
    expect(body.entries.map((e) => e.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (let i = 1; i < body.entries.length; i++) {
      const [prev, cur] = [body.entries[i - 1]!, body.entries[i]!];
      expect(prev.rating > cur.rating || (prev.rating === cur.rating && prev.profileId < cur.profileId)).toBe(true);
    }
    expect(body.entries.map((e) => e.profileId)).not.toContain(loner);
    expect(body.entries[0]).toMatchObject({ profileId: ids[0], nickname: 'P00' });
    expect(Object.keys(body.entries[0]!).sort()).toEqual(['duraks', 'nickname', 'profileId', 'rank', 'ratedGames', 'rating', 'wins']);
  });

  it('a public profile: stats, the same rank as the leaderboard, the last 20 games newest first', async () => {
    const board = (await get<LeaderboardResponse>('/api/leaderboard')).body.entries;
    for (const entry of board.slice(0, 5)) {
      const { body } = await get<PublicProfile>(`/api/profile/${entry.profileId}`);
      expect(body).toMatchObject({ profileId: entry.profileId, rating: entry.rating, rank: entry.rank, wins: entry.wins, duraks: entry.duraks });
    }
    const { status, body: top } = await get<PublicProfile>(`/api/profile/${ids[0]}`);
    expect(status).toBe(200);
    expect(top.games).toBe(top.ratedGames + 25);
    expect(top.recent).toHaveLength(20);
    const times = top.recent.map((g) => g.endedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(top.recent[0]).toMatchObject({ mode: 'perevodnoy', endReason: 'normal', rated: false, result: 'win', ratingBefore: null });
    expect(top.recent[0]!.others).toEqual([{ nickname: 'Bot 1', isBot: true, profileId: null, result: 'durak' }]);
    // The JSON never carries hashes or keys.
    expect(JSON.stringify(top)).not.toMatch(/hash|deviceKey/i);
  });

  it('a profile with only unrated games has no rank', async () => {
    const { body } = await get<PublicProfile>(`/api/profile/${loner}`);
    expect(body).toMatchObject({ rank: null, games: 1, ratedGames: 0, wins: 0, duraks: 1, rating: 1000, tournamentsWon: 0 });
    expect(body.recent[0]).toMatchObject({ result: 'durak', rated: false });
  });

  it('unknown id → 404, malformed id → 400', async () => {
    expect(await get(`/api/profile/${'z'.repeat(22)}`)).toEqual({ status: 404, body: { error: 'NOT_FOUND' } });
    expect(await get('/api/profile/short')).toEqual({ status: 400, body: { error: 'INVALID_PAYLOAD' } });
  });
});

describe('history endpoints without Postgres', () => {
  it('answer 503 RATINGS_UNAVAILABLE', async () => {
    const time = new FakeTime();
    const server = buildServer({ clock: time, scheduler: time, botRunner: new InProcessRunner() });
    try {
      for (const url of ['/api/leaderboard', `/api/profile/${'a'.repeat(22)}`]) {
        const res = await server.app.inject({ method: 'GET', url });
        expect([res.statusCode, res.json()]).toEqual([503, { error: 'RATINGS_UNAVAILABLE' }]);
      }
    } finally {
      await server.app.close();
    }
  });
});
