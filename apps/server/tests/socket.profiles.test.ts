import { afterEach, describe, expect, it } from 'vitest';
import { MemoryProfileStore } from '../src/ratings/MemoryProfileStore.js';
import type { ProfileStore } from '../src/ratings/ports.js';
import { startGame, startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
let raw: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  raw = [];
});

async function start(profiles: ProfileStore, profileLookupMs?: number): Promise<TestHarness> {
  harness = await startTestServer({
    profiles,
    ...(profileLookupMs !== undefined ? { profileLookupMs } : {}),
    logger: { level: 'info', stream: { write: (line: string) => void raw.push(line) } },
  });
  return harness;
}

async function seat(client: TestClient, room: string | null, nickname: string, deviceKey?: string) {
  const key = deviceKey ? { deviceKey } : {};
  if (room === null) client.send('room:create', { nickname, maxPlayers: 3, ...key });
  else client.send('room:join', { roomId: room, nickname, ...key });
  return client.waitFor('session:issued');
}

async function members(h: TestHarness, roomId: string) {
  return (await h.server.repos.rooms.get(roomId))!.members.map((m) => ({ id: m.playerId, profileId: m.profileId }));
}

describe('seats linked to profiles (room:create / room:join deviceKey)', () => {
  it('links each seat to its profile; room:state never carries profile ids', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    const b = await store.create('B');
    const h = await start(store);
    const host = await h.connect();
    const guest = await h.connect();
    const hs = await seat(host, null, 'A', a.deviceKey);
    const gs = await seat(guest, hs.roomId, 'B', b.deviceKey);
    expect(await members(h, hs.roomId)).toEqual([
      { id: hs.playerId, profileId: a.profileId },
      { id: gs.playerId, profileId: b.profileId },
    ]);
    const state = await guest.waitFor('room:state', (s) => s.members.length === 2);
    expect(JSON.stringify(state)).not.toContain(a.profileId);
    expect(state.members[0]).not.toHaveProperty('profileId');
  });

  it('one profile, one seat: a second tab with the same key is seated unprofiled, without an error', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    const h = await start(store);
    const tab1 = await h.connect();
    const tab2 = await h.connect();
    const s1 = await seat(tab1, null, 'A', a.deviceKey);
    const s2 = await seat(tab2, s1.roomId, 'A again', a.deviceKey);
    expect(await members(h, s1.roomId)).toEqual([
      { id: s1.playerId, profileId: a.profileId },
      { id: s2.playerId, profileId: null },
    ]);
    expect(tab2.received.filter((r) => r.event === 'error')).toEqual([]);
  });

  it('the deal snapshots profiled humans only (bots never)', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    const h = await start(store);
    const host = await h.connect();
    const guest = await h.connect();
    const hs = await seat(host, null, 'A', a.deviceKey);
    const gs = await seat(guest, hs.roomId, 'Guest'); // no profile
    host.send('room:addBot', { roomId: hs.roomId, difficulty: 'easy' });
    await host.waitFor('room:state', (s) => s.members.length === 3);
    await startGame(host, [host, guest], hs.roomId);
    const game = await h.server.repos.games.get(hs.roomId);
    expect(game!.profiles).toEqual({ [hs.playerId]: a.profileId });
    expect(gs.playerId in game!.profiles).toBe(false);
  });

  it('a dead profile store seats players unprofiled and the game still starts', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    store.available = false;
    const h = await start(store);
    const host = await h.connect();
    const guest = await h.connect();
    const hs = await seat(host, null, 'A', a.deviceKey);
    await seat(guest, hs.roomId, 'B', 'Z'.repeat(43));
    expect((await members(h, hs.roomId)).map((m) => m.profileId)).toEqual([null, null]);
    await startGame(host, [host, guest], hs.roomId);
    expect((await h.server.repos.games.get(hs.roomId))!.profiles).toEqual({});
  });

  it('a lookup that never answers: seated unprofiled after the bounded wait', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    store.resolveKey = () => new Promise(() => {});
    const h = await start(store, 50);
    const c = await h.connect();
    const started = Date.now();
    const s = await seat(c, null, 'A', a.deviceKey);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await members(h, s.roomId)).toEqual([{ id: s.playerId, profileId: null }]);
  });

  it('the device key never reaches the log', async () => {
    const store = new MemoryProfileStore();
    const a = await store.create('A');
    const h = await start(store);
    const host = await h.connect();
    await seat(host, null, 'A', a.deviceKey);
    const other = await h.connect();
    other.send('room:create', { nickname: 'x', maxPlayers: 2, deviceKey: `${a.deviceKey}!` }); // invalid payload
    await other.waitFor('error');
    expect(raw.join('')).not.toContain(a.deviceKey);
  });
});
