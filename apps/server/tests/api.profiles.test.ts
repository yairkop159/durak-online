import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCredentials } from '@durak/shared';
import type { InjectOptions } from 'fastify';
import { buildServer, type DurakServer } from '../src/app.js';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { UNLIMITED_API, type ApiLimits } from '../src/http/api.js';
import { MemoryProfileStore } from '../src/ratings/MemoryProfileStore.js';
import { FakeTime } from './helpers/fakeTime.js';

let server: DurakServer | undefined;
let raw: string[] = [];
afterEach(async () => {
  await server?.app.close();
  server = undefined;
  raw = [];
});

function start(
  options: { limits?: Partial<ApiLimits>; store?: MemoryProfileStore; trustedProxies?: string[] } = {},
): { server: DurakServer; store: MemoryProfileStore; time: FakeTime } {
  const time = new FakeTime();
  const store = options.store ?? new MemoryProfileStore();
  server = buildServer({
    clock: time,
    scheduler: time,
    botRunner: new InProcessRunner(),
    profiles: store,
    apiLimits: { ...UNLIMITED_API, ...options.limits },
    corsOrigins: ['http://localhost:5173'],
    logger: { level: 'info', stream: { write: (line: string) => void raw.push(line) } },
    ...(options.trustedProxies ? { trustProxy: 1, trustedProxies: options.trustedProxies } : {}),
  });
  return { server, store, time };
}

async function call(s: DurakServer, opts: InjectOptions) {
  const res = await s.app.inject(opts);
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null, headers: res.headers };
}
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function create(s: DurakServer, nickname = 'Dana'): Promise<ProfileCredentials> {
  const res = await call(s, { method: 'POST', url: '/api/profile', payload: { nickname } });
  expect(res.status).toBe(200);
  return res.body as unknown as ProfileCredentials;
}

describe('/api/profile', () => {
  it('create → me → rename', async () => {
    const { server: s } = start();
    const p = await create(s, '  Dana  ');
    expect(p.nickname).toBe('Dana');
    expect(await call(s, { method: 'GET', url: '/api/profile/me', headers: auth(p.deviceKey) })).toMatchObject({
      status: 200,
      body: { profileId: p.profileId, nickname: 'Dana' },
    });
    expect(
      await call(s, { method: 'PATCH', url: '/api/profile/me', headers: auth(p.deviceKey), payload: { nickname: 'Dana K' } }),
    ).toMatchObject({ status: 200, body: { profileId: p.profileId, nickname: 'Dana K' } });
  });

  it('validates bodies and keys with the shared schemas', async () => {
    const { server: s } = start();
    for (const payload of [{}, { nickname: '' }, { nickname: 'x'.repeat(25) }, { nickname: 'a', extra: 1 }]) {
      expect(await call(s, { method: 'POST', url: '/api/profile', payload })).toMatchObject({ status: 400, body: { error: 'INVALID_PAYLOAD' } });
    }
    expect(
      await call(s, { method: 'POST', url: '/api/profile', payload: 'not json', headers: { 'content-type': 'application/json' } }),
    ).toMatchObject({ status: 400, body: { error: 'INVALID_PAYLOAD' } });
    expect(await call(s, { method: 'POST', url: '/api/profile', payload: { nickname: 'x'.repeat(5000) } })).toMatchObject({
      body: { error: 'INVALID_PAYLOAD' },
    });
    for (const headers of [{}, { authorization: 'Bearer short' }, { authorization: `Basic ${'A'.repeat(43)}` }, auth('A'.repeat(43))]) {
      expect(await call(s, { method: 'GET', url: '/api/profile/me', headers })).toMatchObject({ status: 401, body: { error: 'UNAUTHORIZED' } });
    }
  });

  it('transfer: the code moves the profile, the old key gets 401, a reused or expired code is INVALID_CODE', async () => {
    const { server: s, time } = start();
    const old = await create(s);
    const issued = await call(s, { method: 'POST', url: '/api/profile/transfer-code', headers: auth(old.deviceKey) });
    expect(issued.status).toBe(200);
    const { code, expiresAt, serverTime } = issued.body as { code: string; expiresAt: number; serverTime: number };
    expect(expiresAt - serverTime).toBe(10 * 60_000);

    // Typed by hand on the other device: lower case, with a dash.
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const claimed = await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code: typed } });
    expect(claimed).toMatchObject({ status: 200, body: { profileId: old.profileId, nickname: 'Dana' } });
    const fresh = claimed.body as unknown as ProfileCredentials;
    expect(fresh.deviceKey).not.toBe(old.deviceKey);
    expect((await call(s, { method: 'GET', url: '/api/profile/me', headers: auth(old.deviceKey) })).status).toBe(401);
    expect((await call(s, { method: 'GET', url: '/api/profile/me', headers: auth(fresh.deviceKey) })).status).toBe(200);
    expect(await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code } })).toMatchObject({
      status: 400,
      body: { error: 'INVALID_CODE' },
    });

    const again = await call(s, { method: 'POST', url: '/api/profile/transfer-code', headers: auth(fresh.deviceKey) });
    await time.advanceBy(10 * 60_000 + 1);
    expect(
      await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code: (again.body as { code: string }).code } }),
    ).toMatchObject({ status: 400, body: { error: 'INVALID_CODE' } });
    expect(await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code: 'nope' } })).toMatchObject({
      status: 400,
      body: { error: 'INVALID_PAYLOAD' },
    });
  });

  it('Postgres down: 503 RATINGS_UNAVAILABLE, and /health is still 200', async () => {
    const { server: s, store } = start();
    store.available = false;
    expect(await call(s, { method: 'POST', url: '/api/profile', payload: { nickname: 'a' } })).toMatchObject({
      status: 503,
      body: { error: 'RATINGS_UNAVAILABLE' },
    });
    expect((await call(s, { method: 'GET', url: '/health' })).status).toBe(200);
  });

  it('without an injected store and no database the API is unavailable, never crashing', async () => {
    const time = new FakeTime();
    server = buildServer({ clock: time, scheduler: time, botRunner: new InProcessRunner() });
    expect(await call(server, { method: 'POST', url: '/api/profile', payload: { nickname: 'a' } })).toMatchObject({
      status: 503,
      body: { error: 'RATINGS_UNAVAILABLE' },
    });
  });

  it('unknown /api paths are JSON 404s (never the SPA)', async () => {
    const { server: s } = start();
    expect(await call(s, { method: 'GET', url: '/api/nope' })).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
  });

  it('CORS: listed origins get headers and a preflight; others get none', async () => {
    const { server: s } = start();
    const pre = await call(s, {
      method: 'OPTIONS',
      url: '/api/profile/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PATCH' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('authorization');
    const other = await call(s, { method: 'POST', url: '/api/profile', payload: { nickname: 'a' }, headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the device key and the transfer code never reach the log', async () => {
    const { server: s } = start();
    const p = await create(s);
    await call(s, { method: 'GET', url: '/api/profile/me', headers: auth(p.deviceKey) });
    const issued = await call(s, { method: 'POST', url: '/api/profile/transfer-code', headers: auth(p.deviceKey) });
    const code = (issued.body as { code: string }).code;
    const claimed = await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code } });
    const log = raw.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [p.deviceKey, code, (claimed.body as { deviceKey: string }).deviceKey]) expect(log).not.toContain(secret);
  });
});

describe('/api abuse limits (per client IP)', () => {
  it('profile creation per hour', async () => {
    const { server: s, time } = start({ limits: { profileCreatesPerHour: 2 } });
    await create(s);
    await create(s);
    expect(await call(s, { method: 'POST', url: '/api/profile', payload: { nickname: 'c' } })).toMatchObject({
      status: 429,
      body: { error: 'RATE_LIMITED' },
    });
    await time.advanceBy(60 * 60_000 + 1);
    await create(s);
  });

  it('claims per 10 minutes count every guess, well-formed or not', async () => {
    const { server: s } = start({ limits: { claimsPerTenMinutes: 3 } });
    for (const code of ['nope', 'AAAA-AAAA', 'BBBBBBBB']) {
      expect((await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code } })).status).toBe(400);
    }
    expect((await call(s, { method: 'POST', url: '/api/profile/claim', payload: { code: 'CCCCCCCC' } })).status).toBe(429);
  });

  it('behind a trusted proxy two clients have separate buckets; a forged header from another peer does not help', async () => {
    const { server: s } = start({ limits: { profileCreatesPerHour: 1 }, trustedProxies: ['127.0.0.1/32'] });
    // app.inject's peer is 127.0.0.1: a trusted proxy here.
    const post = (xff: string) =>
      call(s, { method: 'POST', url: '/api/profile', payload: { nickname: 'a' }, headers: { 'x-forwarded-for': xff } });
    expect((await post('1.1.1.1')).status).toBe(200);
    expect((await post('2.2.2.2')).status).toBe(200);
    expect((await post('1.1.1.1')).status).toBe(429);

    await server!.app.close();
    const { server: s2 } = start({ limits: { profileCreatesPerHour: 1 }, trustedProxies: ['172.30.80.0/24'] });
    const post2 = (xff: string) =>
      call(s2, { method: 'POST', url: '/api/profile', payload: { nickname: 'a' }, headers: { 'x-forwarded-for': xff } });
    expect((await post2('1.1.1.1')).status).toBe(200);
    expect((await post2('2.2.2.2')).status).toBe(429); // untrusted peer: both are 127.0.0.1
  });

  it('any /api request per minute', async () => {
    const { server: s } = start({ limits: { requestsPerMinute: 2 } });
    await call(s, { method: 'GET', url: '/api/profile/me' });
    await call(s, { method: 'GET', url: '/api/profile/me' });
    expect(await call(s, { method: 'GET', url: '/api/profile/me' })).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED' } });
  });
});
