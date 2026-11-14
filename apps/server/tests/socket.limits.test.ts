import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { UNLIMITED, type LimitSettings } from '../src/transport/rateLimit.js';
import { startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const HOUR = 60 * 60 * 1000;

async function start(
  limits: Partial<LimitSettings>,
  extra: { trustProxy?: number; trustedProxies?: string[]; trustCfConnectingIp?: boolean } = {},
): Promise<TestHarness> {
  harness = await startTestServer({ limits: { ...UNLIMITED, ...limits }, ...extra });
  return harness;
}

/** Sends a cheap event that always answers (NOT_IN_ROOM for a connection without a session). */
function poke(client: TestClient): void {
  client.send('game:move', { roomId: 'abcd1234', move: { type: 'pass' }, expectedVersion: 0 });
}

function errorCodes(client: TestClient, since = 0): string[] {
  return client.received.slice(since).filter((r) => r.event === 'error').map((r) => (r.payload as { code: string }).code);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function createRoom(client: TestClient): Promise<string> {
  const since = client.mark();
  client.send('room:create', { nickname: 'host', maxPlayers: 2 });
  const outcome = await Promise.race([
    client.waitFor('session:issued', () => true, since).then(() => 'ok'),
    client.waitFor('error', () => true, since).then((e) => e.code),
  ]);
  return outcome;
}

describe('per-socket rate limiting (token bucket)', () => {
  it('drops events past the burst with one RATE_LIMITED notice, then recovers at the sustained rate', async () => {
    const h = await start({ eventBurst: 5, eventsPerSecond: 2, dropsBeforeDisconnect: 1000 });
    const client = await h.connect();

    for (let i = 0; i < 9; i++) poke(client);
    await waitUntil(() => errorCodes(client).filter((c) => c === 'NOT_IN_ROOM').length === 5);
    await waitUntil(() => errorCodes(client).includes('RATE_LIMITED'));
    // 5 handled, 4 dropped silently except for a single notice.
    expect(errorCodes(client).filter((c) => c === 'RATE_LIMITED')).toHaveLength(1);
    expect(client.socket.connected).toBe(true);

    await h.time.advanceBy(1000); // 2 tokens back
    const since = client.mark();
    for (let i = 0; i < 3; i++) poke(client);
    await waitUntil(() => errorCodes(client, since).filter((c) => c === 'NOT_IN_ROOM').length === 2);
    await waitUntil(() => errorCodes(client, since).includes('RATE_LIMITED'));

    // Limits are per socket: a fresh connection is unaffected.
    const other = await h.connect();
    expect(await createRoom(other)).toBe('ok');
  });

  it('counts unknown and malformed events too (checked before validation)', async () => {
    const h = await start({ eventBurst: 3, eventsPerSecond: 1, dropsBeforeDisconnect: 1000 });
    const client = await h.connect();
    for (let i = 0; i < 3; i++) client.send('no:such:event', {});
    client.send('room:create', { nickname: 'ok', maxPlayers: 2 });
    await waitUntil(() => errorCodes(client).includes('RATE_LIMITED'));
    expect(client.all('session:issued')).toHaveLength(0);
  });

  it('disconnects a socket that keeps flooding; the server keeps serving', async () => {
    const h = await start({ eventBurst: 5, eventsPerSecond: 1, dropsBeforeDisconnect: 20 });
    const flooder = await h.connect();
    for (let i = 0; i < 100; i++) poke(flooder);
    await flooder.waitForDisconnect();

    const fresh = await h.connect();
    expect(await createRoom(fresh)).toBe('ok');
  });
});

describe('connections per IP', () => {
  it('refuses the handshake past the limit and frees the slot on disconnect', async () => {
    const h = await start({ socketsPerIp: 2 });
    const a = await h.connect();
    await h.connect();
    await expect(h.connect()).rejects.toThrow('TOO_MANY_CONNECTIONS');

    a.socket.disconnect();
    let reconnected: TestClient | undefined;
    await waitUntil(async () => {
      reconnected = await h.connect().catch(() => undefined);
      return reconnected !== undefined;
    });
    expect(await createRoom(reconnected!)).toBe('ok');
  });

  it('without trusted proxies, X-Forwarded-For is ignored (a client cannot dodge the limit)', async () => {
    const h = await start({ socketsPerIp: 1 });
    await h.connect({ 'x-forwarded-for': '1.1.1.1' });
    await expect(h.connect({ 'x-forwarded-for': '2.2.2.2' })).rejects.toThrow('TOO_MANY_CONNECTIONS');
  });

  it('behind one trusted proxy, clients are told apart by X-Forwarded-For', async () => {
    const h = await start({ socketsPerIp: 1 }, { trustProxy: 1 });
    await h.connect({ 'x-forwarded-for': '1.1.1.1' });
    await h.connect({ 'x-forwarded-for': '2.2.2.2' });
    // A spoofed prefix doesn't help: the proxy-appended (rightmost) entry is the client.
    await expect(h.connect({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1' })).rejects.toThrow('TOO_MANY_CONNECTIONS');
  });

  it('a trusted proxy peer (TRUSTED_PROXIES): clients get separate buckets, by CF-Connecting-IP too', async () => {
    const h = await start({ socketsPerIp: 1 }, { trustProxy: 1, trustedProxies: ['127.0.0.1/32', '::1/128'], trustCfConnectingIp: true });
    await h.connect({ 'cf-connecting-ip': '1.1.1.1' });
    await h.connect({ 'cf-connecting-ip': '2.2.2.2' });
    await h.connect({ 'x-forwarded-for': '3.3.3.3' });
    await expect(h.connect({ 'cf-connecting-ip': '1.1.1.1' })).rejects.toThrow('TOO_MANY_CONNECTIONS');
  });

  it('a peer outside TRUSTED_PROXIES cannot dodge the limit with forged headers', async () => {
    const h = await start({ socketsPerIp: 1 }, { trustProxy: 1, trustedProxies: ['172.30.80.0/24'], trustCfConnectingIp: true });
    await h.connect({ 'x-forwarded-for': '1.1.1.1' });
    await expect(h.connect({ 'x-forwarded-for': '2.2.2.2' })).rejects.toThrow('TOO_MANY_CONNECTIONS');
    await expect(h.connect({ 'cf-connecting-ip': '3.3.3.3' })).rejects.toThrow('TOO_MANY_CONNECTIONS');
  });
});

describe('room creation limits', () => {
  it('limits rooms created per IP per rolling hour', async () => {
    const h = await start({ roomsPerIpPerHour: 2 });
    expect(await createRoom(await h.connect())).toBe('ok');
    expect(await createRoom(await h.connect())).toBe('ok');
    const third = await h.connect();
    expect(await createRoom(third)).toBe('TOO_MANY_ROOMS');

    await h.time.advanceBy(HOUR + 1);
    expect(await createRoom(third)).toBe('ok');
  });

  it('a refused creation does not use up the hourly quota', async () => {
    const h = await start({ roomsPerIpPerHour: 2, maxRooms: 1 });
    const first = await h.connect();
    expect(await createRoom(first)).toBe('ok'); // quota 1/2
    const second = await h.connect();
    expect(await createRoom(second)).toBe('SERVER_FULL'); // not charged

    const roomId = first.last('session:issued')!.roomId;
    first.send('room:leave', { roomId });
    await waitUntil(async () => (await h.server.repos.rooms.get(roomId)) === null);
    expect(await createRoom(second)).toBe('ok'); // quota 2/2: only possible if SERVER_FULL was free
    expect(await createRoom(await h.connect())).toBe('TOO_MANY_ROOMS');
  });

  it('caps concurrent rooms (SERVER_FULL) and frees a slot when a room is deleted', async () => {
    const h = await start({ maxRooms: 2 });
    const first = await h.connect();
    expect(await createRoom(first)).toBe('ok');
    expect(await createRoom(await h.connect())).toBe('ok');
    const third = await h.connect();
    expect(await createRoom(third)).toBe('SERVER_FULL');

    // The only human leaves their lobby: the room is deleted.
    const roomId = first.last('session:issued')!.roomId;
    first.send('room:leave', { roomId });
    await waitUntil(async () => (await h.server.repos.rooms.get(roomId)) === null);
    expect(await createRoom(third)).toBe('ok');
  });
});

describe('Origin check', () => {
  it('refuses a WebSocket handshake from a foreign origin, accepts its own and listed ones', async () => {
    const h = await start({});
    await expect(h.connect({ origin: 'https://evil.example' })).rejects.toThrow();
    await h.connect({ origin: h.url });
    await h.connect({ origin: 'http://localhost:5173' }); // the default dev CORS origin
  });

  it('same-origin only in production (no CORS origins)', async () => {
    harness = await startTestServer({ limits: UNLIMITED, corsOrigins: [] });
    await expect(harness.connect({ origin: 'http://localhost:5173' })).rejects.toThrow();
    await harness.connect({ origin: harness.url });
  });
});

describe('no internals leak to clients', () => {
  it('a failing HTTP route returns a generic 500 body', async () => {
    const server = buildServer({ botRunner: new InProcessRunner() });
    server.app.get('/boom', async () => {
      throw new Error('secret: redis://user:pw@10.0.0.3 at /app/src/x.ts:12');
    });
    const res = await server.app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.body).not.toMatch(/secret|stack|\.ts/);
    // 4xx keep their (safe) message.
    const notFound = await server.app.inject({ method: 'GET', url: '/nope' });
    expect(notFound.statusCode).toBe(404);
    await server.app.close();
  });

  it('a throwing socket handler becomes a generic INTERNAL error', async () => {
    const h = await start({});
    h.server.rooms.createRoom = async () => {
      throw new Error('secret: stack trace with /app/src/services/RoomService.ts');
    };
    const client = await h.connect();
    client.send('room:create', { nickname: 'x', maxPlayers: 2 });
    const error = await client.waitFor('error');
    expect(error).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
  });
});
