import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProfileCredentials } from '@durak/shared';
import { createDatabase, type Database } from '../src/db/database.js';
import { autoPlay } from './helpers/autoPlay.js';
import { FakeTime } from './helpers/fakeTime.js';
import { freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';
import { startGame, startTestServer, type TestHarness } from './helpers/testServer.js';

const suite = postgresAvailable ? describe : describe.skip;

suite('end to end (real sockets, HTTP and Postgres): a finished game is rated once', () => {
  let tdb: TestDatabase;
  let harness: TestHarness | undefined;
  let database: Database | undefined;
  beforeAll(async () => {
    tdb = await freshDatabase();
  }, 60_000);
  afterEach(async () => {
    await harness?.close(); // closes the database too
    harness = undefined;
  });
  afterAll(async () => tdb?.drop());

  async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
    const end = Date.now() + 10_000;
    for (;;) {
      const v = await read();
      if (done(v)) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('profiles over /api → seats → game:over → games, game_players and ratings in Postgres', async () => {
    const time = new FakeTime();
    database = createDatabase({ url: tdb.url, migrateOnStart: false, log: { info: vi.fn(), warn: vi.fn() }, clock: time, scheduler: time });
    await database.start();
    harness = await startTestServer({ time, database });
    const post = async (nickname: string) =>
      (await (
        await fetch(`${harness!.url}/api/profile`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nickname }),
        })
      ).json()) as ProfileCredentials;
    const a = await post('A');
    const b = await post('B');

    const host = await harness.connect();
    const guest = await harness.connect();
    host.send('room:create', { nickname: 'A', maxPlayers: 2, deviceKey: a.deviceKey });
    const hs = await host.waitFor('session:issued');
    guest.send('room:join', { roomId: hs.roomId, nickname: 'B', deviceKey: b.deviceKey });
    const gs = await guest.waitFor('session:issued');
    await startGame(host, [host, guest], hs.roomId);
    autoPlay(host, hs.roomId);
    autoPlay(guest, hs.roomId);
    const over = await host.waitFor('game:over', () => true, 0, 15_000);
    const game = await harness.server.repos.games.get(hs.roomId);

    const rows = await eventually(
      () => tdb.query<{ profile_id: string; result: string; rating_after: number }>('SELECT profile_id, result, rating_after FROM game_players WHERE game_id = $1 ORDER BY seat', [game!.gameId]),
      (r) => r.length === 2,
      'the game to be stored',
    );
    const ratings = Object.fromEntries((await tdb.query<{ id: string; rating: number }>('SELECT id, rating FROM profiles')).map((r) => [r.id, r.rating]));
    if (over.durakId === null) {
      expect(ratings).toEqual({ [a.profileId]: 1000, [b.profileId]: 1000 });
    } else {
      const loser = over.durakId === hs.playerId ? a.profileId : b.profileId;
      const winner = loser === a.profileId ? b.profileId : a.profileId;
      expect(ratings).toEqual({ [winner]: 1016, [loser]: 984 });
      expect(rows.find((r) => r.profile_id === loser)).toMatchObject({ result: 'durak', rating_after: 984 });
    }

    // game:ratings: pending right after game:over, then rated with exactly what Postgres holds.
    const rated = await host.waitFor('game:ratings', (p) => p.status === 'rated', 0, 10_000);
    for (const client of [host, guest]) {
      expect(client.all('game:ratings').map((p) => p.status)).toEqual(['pending', 'rated']);
    }
    const seats = await tdb.query<{ seat: number; rating_before: number; rating_after: number }>(
      'SELECT seat, rating_before, rating_after FROM game_players WHERE game_id = $1 ORDER BY seat',
      [game!.gameId],
    );
    expect(rated).toEqual({
      roomId: hs.roomId,
      gameId: game!.gameId,
      status: 'rated',
      entries: seats.map((r) => ({
        playerId: game!.state.players[r.seat]!.id,
        before: r.rating_before,
        after: r.rating_after,
        delta: r.rating_after - r.rating_before,
      })),
    });

    // Re-submission (as on startup) changes nothing.
    await harness.server.recorder.resubmitFinished(harness.server.repos);
    await time.advanceBy(0);
    await new Promise((r) => setTimeout(r, 300));
    expect((await tdb.query('SELECT 1 FROM games')).length).toBe(1);
    expect(host.all('game:ratings').filter((p) => p.status === 'rated')).toHaveLength(1); // a duplicate announces nothing
    expect(Object.fromEntries((await tdb.query<{ id: string; rating: number }>('SELECT id, rating FROM profiles')).map((r) => [r.id, r.rating]))).toEqual(
      ratings,
    );
  
    // A reload: a new socket resumes the session and gets the delta again, after the finished view.
    const reloaded = await harness.connect();
    reloaded.send('session:resume', { sessionToken: gs.sessionToken });
    await reloaded.waitFor('game:state', (st) => st.view.phase.kind === 'finished');
    expect(await reloaded.waitFor('game:ratings')).toEqual(rated);
  }, 30_000);
});
