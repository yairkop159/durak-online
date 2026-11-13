import type { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createMemoryBackend, createRedisBackend, type Backend } from '../src/backend.js';
import { deleteAllWithPrefix, redisKeys } from '../src/repositories/redis/index.js';
import { REDIS_URL, newRedisClient, redisAvailable, spyLogger, testPrefix } from './helpers/redis.js';
import { setupRoom, startGame, startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';
import { chooseMove } from './helpers/viewStrategy.js';
import { autoPlay } from './helpers/autoPlay.js';
import { FakeTime } from './helpers/fakeTime.js';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Starts a server on `backend` exactly as index.ts does: ghost reset, build, re-arm timers, listen. */
async function serverOn(backend: Backend, options: { seed?: number; time?: FakeTime } = {}): Promise<TestHarness> {
  await backend.startup();
  const harness = await startTestServer({
    repos: backend.repos,
    seedSource: () => options.seed ?? 31,
    health: () => backend.health(),
    onClose: () => backend.close(),
    ...(options.time ? { time: options.time } : {}),
  });
  await harness.server.timers.rearmAll();
  harnesses.push(harness);
  return harness;
}

/** The first client that has a move at the latest version plays it; resolves when all see the next version. */
async function playOneMove(clients: TestClient[], roomId: string): Promise<number> {
  const version = Math.max(...clients.map((c) => c.last('game:state')!.version));
  for (const client of clients) {
    const state = client.last('game:state')!;
    if (state.version !== version) continue;
    const move = chooseMove(state.view);
    if (!move) continue;
    client.send('game:move', { roomId, move, expectedVersion: version });
    await Promise.all(clients.map((c) => c.waitFor('game:state', (s) => s.version === version + 1)));
    return version + 1;
  }
  throw new Error(`Nobody can move at version ${version}`);
}

async function getHealth(harness: TestHarness): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${harness.url}/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Orphaned session: the session is valid but its room is gone. */
async function orphanedSessionScenario(harness: TestHarness): Promise<void> {
  const host = await harness.connect();
  const { roomId, sessions } = await setupRoom(host, []);
  const token = sessions[0]!.sessionToken;
  await harness.server.repos.rooms.delete(roomId);

  const client = await harness.connect();
  client.send('session:resume', { sessionToken: token });
  expect((await client.waitFor('error')).code).toBe('ROOM_NOT_FOUND');
  expect(await harness.server.repos.sessions.get(token)).toBeNull();

  const since = client.mark();
  client.send('session:resume', { sessionToken: token });
  expect((await client.waitFor('error', () => true, since)).code).toBe('INVALID_SESSION');
  expect((await getHealth(harness)).status).toBe(200);
}

describe('memory backend', () => {
  it('GET /health reports the memory repository', async () => {
    const harness = await serverOn(createMemoryBackend());
    expect(await getHealth(harness)).toEqual({ status: 200, body: { ok: true, repository: 'memory' } });
  });

  it('an orphaned session is rejected with ROOM_NOT_FOUND and deleted', async () => {
    await orphanedSessionScenario(await serverOn(createMemoryBackend()));
  });
});

const suite = redisAvailable ? describe : describe.skip;

suite('redis backend', () => {
  const prefixes: string[] = [];
  let admin: Redis | undefined;
  const freshPrefix = () => {
    const p = testPrefix();
    prefixes.push(p);
    return p;
  };
  afterAll(async () => {
    admin ??= newRedisClient();
    for (const p of prefixes) await deleteAllWithPrefix(admin, redisKeys(p));
    admin.disconnect();
  });

  it('survives a full server restart: clients resume with old tokens at the same version and keep playing', async () => {
    const prefix = freshPrefix();
    const backendA = await createRedisBackend(REDIS_URL, prefix, spyLogger());
    const serverA = await serverOn(backendA);
    const host = await serverA.connect();
    const guest = await serverA.connect();
    const { roomId, sessions } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);
    for (let i = 0; i < 3; i++) await playOneMove([host, guest], roomId);
    const before = host.last('game:state')!;
    expect(before.version).toBe(3);

    // Kill server A completely: sockets, HTTP and its Redis connection.
    await serverA.close();
    harnesses.splice(harnesses.indexOf(serverA), 1);
    expect(backendA.redis.status).toBe('end');

    const serverB = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()));

    // Ghost reset: right after startup nobody is connected.
    const ghost = await serverB.server.repos.rooms.get(roomId);
    expect(ghost?.status).toBe('playing');
    expect(ghost?.members.map((m) => m.connected)).toEqual([false, false]);

    const host2 = await serverB.connect();
    host2.send('session:resume', { sessionToken: sessions[0]!.sessionToken });
    expect(await host2.waitFor('session:issued')).toEqual(sessions[0]);
    const roomAfterHost = await host2.waitFor('room:state');
    expect(roomAfterHost.members.find((m) => m.playerId === sessions[0]!.playerId)?.connected).toBe(true);
    expect(roomAfterHost.members.find((m) => m.playerId === sessions[1]!.playerId)?.connected).toBe(false);
    const resumed = await host2.waitFor('game:state');
    expect(resumed.version).toBe(before.version);
    expect(resumed.view.hand).toEqual(before.view.hand);

    const guest2 = await serverB.connect();
    guest2.send('session:resume', { sessionToken: sessions[1]!.sessionToken });
    await guest2.waitFor('game:state', (s) => s.version === before.version);

    expect(await playOneMove([host2, guest2], roomId)).toBe(before.version + 1);
    expect((await serverB.server.repos.games.get(roomId))?.version).toBe(before.version + 1);
  });

  it('bot knowledge survives a restart, and rearmAll lets the bot carry on', async () => {
    const prefix = freshPrefix();
    const t0 = 1_700_000_000_000;
    const serverA = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time: new FakeTime(t0) });
    const host = await serverA.connect();
    host.send('room:create', { nickname: 'human', maxPlayers: 2 });
    const { roomId, sessionToken } = await host.waitFor('session:issued');
    host.send('room:addBot', { roomId, difficulty: 'medium' });
    await host.waitFor('room:state', (r) => r.members.length === 2);
    host.send('game:start', { roomId });
    await host.waitFor('game:state', (s) => s.version === 0);
    autoPlay(host, roomId);

    // Play into bout 2+ and stop at a moment when the bot is the one to act.
    const time = serverA.time;
    for (let i = 0; i < 3000; i++) {
      const game = await serverA.server.repos.games.get(roomId);
      if (game!.state.phase.kind === 'finished') throw new Error('game ended too early for this test');
      if (game!.state.boutNumber >= 2 && serverA.server.bots.inFlight.length > 0) break;
      await time.advanceBy(100);
      await new Promise((r) => setTimeout(r, 1));
    }
    const before = (await serverA.server.repos.games.get(roomId))!;
    expect(before.state.boutNumber).toBeGreaterThanOrEqual(2);
    expect(Object.keys(before.knowledge).sort()).toEqual(before.state.players.map((p) => p.id).sort());

    await serverA.close();
    harnesses.splice(harnesses.indexOf(serverA), 1);

    const timeB = new FakeTime(time.now() + 1_000);
    const serverB = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time: timeB });
    const stored = (await serverB.server.repos.games.get(roomId))!;
    expect(stored.knowledge).toEqual(before.knowledge);
    expect(stored.version).toBe(before.version);

    // The bot is still connected (no ghost reset for bots) and plans again after rearmAll.
    const room = await serverB.server.repos.rooms.get(roomId);
    expect(room!.members.find((m) => m.isBot)?.connected).toBe(true);
    expect(serverB.server.bots.inFlight.map((e) => e.version)).toEqual([before.version]);
    await timeB.advanceBy(2_000);
    const after = (await serverB.server.repos.games.get(roomId))!;
    expect(after.version).toBe(before.version + 1);
    expect(serverB.server.bots.events.some((e) => e.kind === 'applied' && e.version === before.version)).toBe(true);

    // The human resumes as usual.
    const host2 = await serverB.connect();
    host2.send('session:resume', { sessionToken });
    await host2.waitFor('game:state', (s) => s.version === before.version + 1);
  });

  it('a corrupted game value yields GAME_NOT_STARTED, is logged, and the server keeps working', async () => {
    const prefix = freshPrefix();
    const log = spyLogger();
    const harness = await serverOn(await createRedisBackend(REDIS_URL, prefix, log));
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);

    admin ??= newRedisClient();
    await admin.set(redisKeys(prefix).game(roomId), '{not json');
    host.send('game:move', { roomId, move: { type: 'pass' }, expectedVersion: 0 });
    expect((await host.waitFor('error')).code).toBe('GAME_NOT_STARTED');
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ reason: 'invalid JSON' }), 'corrupted redis value');

    expect((await getHealth(harness)).status).toBe(200);
    const fresh = await harness.connect();
    fresh.send('room:create', { nickname: 'still-alive', maxPlayers: 2 });
    await fresh.waitFor('session:issued');
  });

  it('an orphaned session is rejected with ROOM_NOT_FOUND and deleted', async () => {
    await orphanedSessionScenario(await serverOn(await createRedisBackend(REDIS_URL, freshPrefix(), spyLogger())));
  });

  /** Server A starts a 2-player game at T0 and is shut down; returns what server B needs. */
  async function gameThenShutdown(prefix: string, t0: number) {
    const serverA = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time: new FakeTime(t0) });
    const host = await serverA.connect();
    const guest = await serverA.connect();
    const { roomId, sessions } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);
    expect((await serverA.server.repos.games.get(roomId))?.turnDeadline).toBe(t0 + 30_000);
    await serverA.close();
    harnesses.splice(harnesses.indexOf(serverA), 1);
    return { roomId, sessions };
  }

  it('restart re-arms a pending turn deadline: it fires at its original time, not earlier', async () => {
    const prefix = freshPrefix();
    const t0 = 1_700_000_000_000;
    const { roomId } = await gameThenShutdown(prefix, t0);

    const time = new FakeTime(t0 + 10_000); // server B comes up 10 s later
    const serverB = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time });
    await time.advanceBy(19_999);
    expect((await serverB.server.repos.games.get(roomId))?.version).toBe(0);
    await time.advanceBy(1);
    const game = await serverB.server.repos.games.get(roomId);
    expect(game?.version).toBe(1);
    expect(game?.state.table).toHaveLength(1);
  });

  it('restart fires an already-expired deadline immediately', async () => {
    const prefix = freshPrefix();
    const t0 = 1_700_000_000_000;
    const { roomId } = await gameThenShutdown(prefix, t0);

    const time = new FakeTime(t0 + 40_000); // down for longer than the turn
    const serverB = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time });
    await time.runDue();
    expect((await serverB.server.repos.games.get(roomId))?.version).toBe(1);
  });

  it('after a restart, ghosts get a reconnection grace: one who returns is safe, one who does not forfeits', async () => {
    const prefix = freshPrefix();
    const t0 = 1_700_000_000_000;
    const { roomId, sessions } = await gameThenShutdown(prefix, t0);

    const time = new FakeTime(t0 + 1_000);
    const serverB = await serverOn(await createRedisBackend(REDIS_URL, prefix, spyLogger()), { time });
    const room = await serverB.server.repos.rooms.get(roomId);
    expect(room?.members.map((m) => [m.connected, m.graceDeadline])).toEqual([
      [false, t0 + 1_000 + 60_000],
      [false, t0 + 1_000 + 60_000],
    ]);

    // The host comes back; the guest never does.
    const host = await serverB.connect();
    host.send('session:resume', { sessionToken: sessions[0]!.sessionToken });
    await host.waitFor('game:state');
    await time.advanceBy(60_000);

    const over = await host.waitFor('game:over');
    expect(over).toMatchObject({ durakId: sessions[1]!.playerId, endReason: 'forfeit' });
    expect((await serverB.server.repos.games.get(roomId))?.endReason).toBe('forfeit');
  });

  it('GET /health pings Redis and returns 503 when it is down', async () => {
    const backend = await createRedisBackend(REDIS_URL, freshPrefix(), spyLogger());
    const harness = await serverOn(backend);
    expect(await getHealth(harness)).toEqual({ status: 200, body: { ok: true, repository: 'redis', redis: 'PONG' } });
    backend.redis.disconnect();
    expect(await getHealth(harness)).toEqual({ status: 503, body: { ok: false, repository: 'redis', redis: 'down' } });
  });
});
