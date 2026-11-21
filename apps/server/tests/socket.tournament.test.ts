import type { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRedisBackend, type Backend } from '../src/backend.js';
import { deleteAllWithPrefix, redisKeys } from '../src/repositories/redis/index.js';
import { autoPlay } from './helpers/autoPlay.js';
import { REDIS_URL, newRedisClient, redisAvailable, spyLogger, testPrefix } from './helpers/redis.js';
import { setupRoom, startGame, startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function serverOn(options: { backend?: Backend } = {}): Promise<TestHarness> {
  if (options.backend) await options.backend.startup();
  const harness = await startTestServer({
    timerSettings: { turnTimeoutMs: 10 * 60_000 },
    ...(options.backend
      ? { repos: options.backend.repos, health: () => options.backend!.health(), onClose: () => options.backend!.close() }
      : {}),
  });
  await harness.server.timers.rearmAll();
  harnesses.push(harness);
  return harness;
}

/** Plays the current game to its end with both clients and waits for the scored room:state. */
async function playGame(clients: TestClient[], roomId: string, gamesPlayed: number): Promise<void> {
  const marks = clients.map((c) => c.mark());
  const players = clients.map((c) => autoPlay(c, roomId));
  await Promise.all(
    clients.map((c, i) =>
      c.waitFor('room:state', (s) => s.status === 'finished' && s.tournament?.gamesPlayed === gamesPlayed, marks[i], 20_000),
    ),
  );
  for (const c of clients) c.socket.off('game:state');
  for (const p of players) expect(p.errors.filter((e) => e.code !== 'STALE_STATE')).toEqual([]);
}

describe('tournament over sockets', () => {
  it('setup in the lobby, standings in room:state after every game (spectators too), next game, champion', async () => {
    const harness = await serverOn();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);

    let since = guest.mark();
    host.send('room:setTournament', { roomId, games: 3 });
    expect((await guest.waitFor('room:state', (s) => s.tournamentSetup?.games === 3, since)).tournament).toBeNull();

    await startGame(host, [host, guest], roomId);
    const started = host.last('room:state')!.tournament!;
    expect(started).toMatchObject({ status: 'running', gamesPlanned: 3, gamesPlayed: 0, teams: false });

    await playGame([host, guest], roomId, 1);
    const watcher = await harness.connect();
    watcher.send('room:join', { roomId, nickname: 'watcher' });
    const seen = await watcher.waitFor('room:state', (s) => s.tournament?.gamesPlayed === 1);
    expect(seen.tournament!.standings).toEqual(host.last('room:state')!.tournament!.standings);

    // Back to the lobby is refused mid-series; the guest may not lead while the host is here.
    since = guest.mark();
    guest.send('room:rematch', { roomId });
    expect((await guest.waitFor('error', () => true, since)).code).toBe('TOURNAMENT_IN_PROGRESS');
    since = guest.mark();
    guest.send('tournament:next', { roomId });
    expect((await guest.waitFor('error', () => true, since)).code).toBe('NOT_HOST');

    for (let n = 2; n <= 3; n++) {
      const marks = [host.mark(), guest.mark()];
      host.send('tournament:next', { roomId });
      await Promise.all([host, guest].map((c, i) => c.waitFor('game:state', (s) => s.version === 0, marks[i])));
      await playGame([host, guest], roomId, n);
    }
    const final = host.last('room:state')!.tournament!;
    expect(final.status).toBe('finished');
    expect(final.champions.length).toBeGreaterThan(0);
    const watched = await watcher.waitFor('room:state', (s) => s.tournament?.status === 'finished');
    expect(watched.tournament!.champions).toEqual(final.champions);
  });

  it('bad tournament payloads are refused with INVALID_PAYLOAD', async () => {
    const harness = await serverOn();
    const host = await harness.connect();
    const { roomId } = await setupRoom(host, []);
    for (const payload of [{ roomId, games: 4 }, { roomId }, { roomId, games: 3, x: 1 }]) {
      const since = host.mark();
      host.send('room:setTournament', payload as never);
      expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');
    }
    const since = host.mark();
    host.send('tournament:next', { roomId });
    expect((await host.waitFor('error', () => true, since)).code).toBe('NO_TOURNAMENT');
  });
});

const suite = redisAvailable ? describe : describe.skip;

suite('tournament on redis', () => {
  const prefixes: string[] = [];
  afterAll(async () => {
    const admin: Redis = newRedisClient();
    for (const p of prefixes) await deleteAllWithPrefix(admin, redisKeys(p));
    admin.disconnect();
  });

  it('survives a server restart between games: resume shows the same table and the series goes on', async () => {
    const prefix = testPrefix();
    prefixes.push(prefix);
    const serverA = await serverOn({ backend: await createRedisBackend(REDIS_URL, prefix, spyLogger()) });
    const host = await serverA.connect();
    const guest = await serverA.connect();
    const { roomId, sessions } = await setupRoom(host, [guest]);
    host.send('room:setTournament', { roomId, games: 3 });
    await host.waitFor('room:state', (s) => s.tournamentSetup !== null);
    await startGame(host, [host, guest], roomId);
    await playGame([host, guest], roomId, 1);
    const before = host.last('room:state')!.tournament!;

    await serverA.close();
    harnesses.splice(harnesses.indexOf(serverA), 1);
    const serverB = await serverOn({ backend: await createRedisBackend(REDIS_URL, prefix, spyLogger()) });

    const host2 = await serverB.connect();
    host2.send('session:resume', { sessionToken: sessions[0]!.sessionToken });
    const resumed = (await host2.waitFor('room:state', (s) => s.tournament !== null)).tournament!;
    expect(resumed.standings).toEqual(before.standings);
    expect(resumed.status).toBe('running');
    expect(resumed.id).toBe(before.id);

    const guest2 = await serverB.connect();
    guest2.send('session:resume', { sessionToken: sessions[1]!.sessionToken });
    await guest2.waitFor('room:state');
    host2.send('tournament:next', { roomId });
    await Promise.all([host2, guest2].map((c) => c.waitFor('game:state', (s) => s.version === 0)));
    await playGame([host2, guest2], roomId, 2);
    expect(host2.last('room:state')!.tournament!.gamesPlayed).toBe(2);
  });
});
