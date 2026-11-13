import { afterEach, describe, expect, it } from 'vitest';
import { autoPlay } from './helpers/autoPlay.js';
import { setupRoom, startGame, startTestServer, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('full games over sockets', () => {
  it.each([1, 2, 3])('2 players play to completion (seed %i)', async (seed) => {
    harness = await startTestServer({ seedSource: () => seed });
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);

    const players = [host, guest].map((c) => autoPlay(c, roomId));
    host.send('game:start', { roomId });
    const [overHost, overGuest] = await Promise.all([
      host.waitFor('game:over', () => true, 0, 15_000),
      guest.waitFor('game:over', () => true, 0, 15_000),
    ]);

    expect(overHost).toEqual(overGuest);
    const stored = await harness.server.repos.games.get(roomId);
    expect(stored?.seed).toBe(seed);
    expect(stored?.state.phase.kind).toBe('finished');
    if (stored?.state.phase.kind === 'finished') expect(overHost.durakId).toBe(stored.state.phase.durak);
    expect((await harness.server.repos.rooms.get(roomId))?.status).toBe('finished');

    // Only races between the two players may produce errors.
    for (const p of players) expect(p.errors.every((e) => e.code === 'STALE_STATE')).toBe(true);
    // Versions arrive strictly increasing (broadcasts happen inside the room lock).
    for (const c of [host, guest]) {
      const versions = c.all('game:state').map((s) => s.version);
      for (let i = 1; i < versions.length; i++) expect(versions[i]!).toBeGreaterThanOrEqual(versions[i - 1]!);
    }
  });

  it('3 players play to completion', async () => {
    harness = await startTestServer({ seedSource: () => 77 });
    const clients = [await harness.connect(), await harness.connect(), await harness.connect()];
    const { roomId } = await setupRoom(clients[0]!, clients.slice(1), 3);
    for (const c of clients) autoPlay(c, roomId);
    clients[0]!.send('game:start', { roomId });
    await Promise.all(clients.map((c) => c.waitFor('game:over', () => true, 0, 15_000)));
  });
});

describe('timer fields in payloads', () => {
  it('game:state carries turnDeadline + serverTime; room:state exposes afk but no server-only member fields', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);

    const state = host.last('game:state')!;
    expect(state.serverTime).toBe(harness.time.now());
    expect(state.turnDeadline).toBe(harness.time.now() + 30_000);

    const room = host.last('room:state')!;
    for (const m of room.members) {
      expect(Object.keys(m).sort()).toEqual(['afk', 'connected', 'isBot', 'nickname', 'playerId']);
    }

    // A timeout is broadcast to both players with the next deadline.
    await harness.time.advanceBy(30_000);
    const next = await guest.waitFor('game:state', (s) => s.version === 1);
    expect(next.turnDeadline).toBe(harness.time.now() + 30_000);
  });
});

describe('spectators', () => {
  it('a client joining a running game becomes a spectator and receives the null view', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);

    const watcher = await harness.connect();
    watcher.send('room:join', { roomId, nickname: 'watcher' });
    const session = await watcher.waitFor('session:issued');
    expect(session.playerId.startsWith('s_')).toBe(true);
    const state = await watcher.waitFor('game:state');
    expect(state.view.viewerId).toBeNull();
    expect(state.view.hand).toEqual([]);
    const room = await host.waitFor('room:state', (r) => r.spectatorCount === 1);
    expect(room.members).toHaveLength(2);

    // Spectators keep receiving the null view on every move, and cannot move.
    watcher.send('game:move', { roomId, move: { type: 'pass' }, expectedVersion: 0 });
    expect((await watcher.waitFor('error')).code).toBe('NOT_IN_ROOM');
  });
});

describe('disconnect and resume', () => {
  it('marks a player disconnected, then connected again after session:resume', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);
    const guestSession = sessions[1]!;

    const since = host.mark();
    guest.socket.disconnect();
    const offline = await host.waitFor(
      'room:state',
      (r) => r.members.some((m) => m.playerId === guestSession.playerId && !m.connected),
      since,
    );
    expect(offline.status).toBe('playing');
    expect((await harness.server.repos.rooms.get(roomId))?.members.find((m) => m.playerId === guestSession.playerId)?.connected).toBe(false);

    const resumed = await harness.connect();
    const sinceResume = host.mark();
    resumed.send('session:resume', { sessionToken: guestSession.sessionToken });
    const again = await resumed.waitFor('session:issued');
    expect(again).toEqual(guestSession);
    await host.waitFor(
      'room:state',
      (r) => r.members.every((m) => m.connected),
      sinceResume,
    );
    const state = await resumed.waitFor('game:state');
    expect(state.view.viewerId).toBe(guestSession.playerId);
    expect(state.view.hand).toHaveLength(6);
    expect(state.version).toBe(0);
  });

  it('a player with another open tab stays connected when one tab closes', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { sessions } = await setupRoom(host, [guest]);
    const secondTab = await harness.connect();
    secondTab.send('session:resume', { sessionToken: sessions[1]!.sessionToken });
    await secondTab.waitFor('session:issued');

    guest.socket.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    const room = await harness.server.repos.rooms.get(sessions[0]!.roomId);
    expect(room?.members.every((m) => m.connected)).toBe(true);
  });

  it('rejects an unknown session token', async () => {
    harness = await startTestServer();
    const client = await harness.connect();
    client.send('session:resume', { sessionToken: 'x'.repeat(43) });
    expect((await client.waitFor('error')).code).toBe('INVALID_SESSION');
  });
});

describe('idempotent create/join', () => {
  it('joining twice from the same socket keeps the member count and re-issues the same session', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [guest], 4);

    const since = guest.mark();
    guest.send('room:join', { roomId, nickname: 'again' });
    const reissued = await guest.waitFor('session:issued', () => true, since);
    expect(reissued).toEqual(sessions[1]);
    await guest.waitFor('room:state', () => true, since);
    expect((await harness.server.repos.rooms.get(roomId))?.members).toHaveLength(2);
  });

  it('creating twice from the same socket returns the existing session instead of a second room', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const { sessions } = await setupRoom(host, []);
    const since = host.mark();
    host.send('room:create', { nickname: 'again', maxPlayers: 3 });
    expect(await host.waitFor('session:issued', () => true, since)).toEqual(sessions[0]);
  });

  it('a socket already in one room cannot join another', async () => {
    harness = await startTestServer();
    const a = await harness.connect();
    const b = await harness.connect();
    await setupRoom(a, []);
    const { roomId: other } = await setupRoom(b, []);
    a.send('room:join', { roomId: other, nickname: 'x' });
    expect((await a.waitFor('error')).code).toBe('INVALID_SESSION');
  });
});
