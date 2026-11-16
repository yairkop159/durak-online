import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db/database.js';
import { MemoryProfileStore } from '../src/ratings/MemoryProfileStore.js';
import { autoPlay } from './helpers/autoPlay.js';
import { FakeTime } from './helpers/fakeTime.js';
import { DEAD_POSTGRES_URL } from './helpers/postgres.js';
import { startGame, startTestServer, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('Postgres outage: play is unaffected (real sockets, real Prisma stores)', () => {
  it('two profiled humans play a whole game to game:over while Postgres is unreachable', async () => {
    const time = new FakeTime();
    const dbLog = { info: vi.fn(), warn: vi.fn() };
    const database = createDatabase({ url: DEAD_POSTGRES_URL, migrateOnStart: false, log: dbLog, clock: time, scheduler: time });
    await database.start(); // fails fast (closed port), schedules a retry on fake time
    expect(dbLog.warn).toHaveBeenCalled();

    // Profiles resolve from memory, so both seats are profiled and the result must be recorded:
    // the real PrismaResultStore then hits the dead database.
    const profiles = new MemoryProfileStore();
    const [a, b] = [await profiles.create('A'), await profiles.create('B')];
    harness = await startTestServer({ time, database, profiles });
    const host = await harness.connect();
    const guest = await harness.connect();
    host.send('room:create', { nickname: 'A', maxPlayers: 2, deviceKey: a.deviceKey });
    const hs = await host.waitFor('session:issued');
    guest.send('room:join', { roomId: hs.roomId, nickname: 'B', deviceKey: b.deviceKey });
    await guest.waitFor('session:issued');
    await startGame(host, [host, guest], hs.roomId);

    const errors = [autoPlay(host, hs.roomId).errors, autoPlay(guest, hs.roomId).errors];
    const over = await host.waitFor('game:over', () => true, 0, 15_000);
    expect(over.endReason).toBe('normal');
    expect(errors.flat().filter((e) => e.code !== 'STALE_STATE')).toEqual([]);

    // The result is waiting for Postgres; the server is healthy and reports the outage.
    await time.advanceBy(0);
    expect(harness.server.resultQueue.size).toBe(1);
    const health = await fetch(`${harness.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, postgres: 'down' });
    // No rating status at all while Postgres is down: the game-over screen shows nothing.
    expect([...host.all('game:ratings'), ...guest.all('game:ratings')]).toEqual([]);

    // A new game in the same room still works.
    host.send('room:rematch', { roomId: hs.roomId });
    await host.waitFor('room:state', (s) => s.status === 'lobby');
    await startGame(host, [host, guest], hs.roomId);
  }, 30_000);
});
