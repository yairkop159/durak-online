import { describe, expect, it } from 'vitest';
import { cgroupCpuLimit, defaultBotWorkers, usableCpus } from '../src/bot/cpus.js';
import { DEFAULT_CORS_ORIGINS, loadConfig, parseCorsOrigins, parseLimits } from '../src/config.js';
import { clientIp, isOriginAllowed, parseTrustProxy } from '../src/transport/clientAddress.js';
import { DEFAULT_LIMITS } from '../src/transport/rateLimit.js';

describe('CORS origins', () => {
  it('defaults to the Vite dev server in development and to same-origin only in production', () => {
    expect(parseCorsOrigins(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(parseCorsOrigins(undefined, true)).toEqual([]);
    expect(parseCorsOrigins(' ', true)).toEqual([]);
    expect(loadConfig({ NODE_ENV: 'production' }).corsOrigins).toEqual([]);
    expect(loadConfig({}).corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  it('accepts explicit origins (trailing slash trimmed) and refuses wildcards and junk', () => {
    expect(parseCorsOrigins('https://a.example, https://b.example:8443/', true)).toEqual([
      'https://a.example',
      'https://b.example:8443',
    ]);
    expect(() => parseCorsOrigins('*', true)).toThrow(/not supported/);
    expect(() => parseCorsOrigins('not a url')).toThrow(/Invalid CORS_ORIGINS/);
    expect(() => parseCorsOrigins('https://a.example/path')).toThrow(/scheme/);
  });
});

describe('limits from the environment', () => {
  it('uses sane defaults', () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toMatchObject({ eventBurst: 20, eventsPerSecond: 10 });
  });

  it('reads every override and rejects invalid values', () => {
    expect(
      parseLimits({
        RATE_LIMIT_BURST: '40',
        RATE_LIMIT_PER_SEC: '20',
        RATE_LIMIT_DISCONNECT_AFTER: '7',
        MAX_ROOMS_PER_IP_PER_HOUR: '5',
        MAX_ROOMS: '50',
        MAX_SOCKETS_PER_IP: '3',
      }),
    ).toEqual({
      eventBurst: 40,
      eventsPerSecond: 20,
      dropsBeforeDisconnect: 7,
      roomsPerIpPerHour: 5,
      maxRooms: 50,
      socketsPerIp: 3,
    });
    expect(() => parseLimits({ MAX_ROOMS: '0' })).toThrow(/MAX_ROOMS/);
    expect(() => parseLimits({ RATE_LIMIT_BURST: '1.5' })).toThrow(/RATE_LIMIT_BURST/);
  });

  it('BOT_WORKERS must be a positive integer when set', () => {
    expect(loadConfig({ BOT_WORKERS: '2' }).botWorkers).toBe(2);
    expect(loadConfig({}).botWorkers).toBeNull();
    expect(() => loadConfig({ BOT_WORKERS: '0' })).toThrow(/BOT_WORKERS/);
  });
});

describe('trust proxy and client IPs', () => {
  it('parses TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(() => parseTrustProxy('-1')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('yes')).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('without trust, X-Forwarded-For is ignored (clients could spoof it)', () => {
    expect(clientIp('10.0.0.5', '1.2.3.4', false)).toBe('10.0.0.5');
    expect(clientIp('::ffff:10.0.0.5', undefined, false)).toBe('10.0.0.5');
  });

  it('with N hops, the entry before our N proxies is the client, whatever the client prepended', () => {
    // Client 7.7.7.7 spoofs "1.1.1.1"; the platform proxy (peer 10.0.0.1) appended the real address.
    expect(clientIp('10.0.0.1', '1.1.1.1, 7.7.7.7', 1)).toBe('7.7.7.7');
    expect(clientIp('10.0.0.1', '1.1.1.1, 7.7.7.7, 10.0.0.9', 2)).toBe('7.7.7.7');
    expect(clientIp('10.0.0.1', ['7.7.7.7'], 1)).toBe('7.7.7.7');
    expect(clientIp('10.0.0.1', '7.7.7.7', 5)).toBe('7.7.7.7'); // more hops than entries: leftmost
    expect(clientIp('10.0.0.1', undefined, 1)).toBe('10.0.0.1');
  });

  it('with trust = true, the leftmost entry is the client', () => {
    expect(clientIp('10.0.0.1', '7.7.7.7, 8.8.8.8', true)).toBe('7.7.7.7');
  });
});

describe('Origin check for the Socket.io handshake', () => {
  it('allows no Origin, the own origin and listed origins; refuses others', () => {
    expect(isOriginAllowed(undefined, 'game.example', [])).toBe(true);
    expect(isOriginAllowed('https://game.example', 'game.example', [])).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', 'localhost:8080', [])).toBe(true);
    expect(isOriginAllowed('https://evil.example', 'game.example', [])).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', 'localhost:3000', ['http://localhost:5173'])).toBe(true);
    expect(isOriginAllowed('https://game.example', undefined, [])).toBe(false);
    expect(isOriginAllowed('null', 'game.example', [])).toBe(false);
  });
});

describe('bot worker default', () => {
  const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

  it('reads the cgroup v2 and v1 CPU quotas', () => {
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '100000 100000\n' }))).toBe(1);
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': '50000 100000' }))).toBe(0.5);
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu.max': 'max 100000' }))).toBeNull();
    expect(
      cgroupCpuLimit(
        files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }),
      ),
    ).toBe(2);
    expect(cgroupCpuLimit(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1' }))).toBeNull();
    expect(cgroupCpuLimit(files({}))).toBeNull();
  });

  it('uses the smaller of visible cores and the quota', () => {
    expect(usableCpus(16, 1)).toBe(1);
    expect(usableCpus(16, 0.25)).toBe(1);
    expect(usableCpus(16, 2.5)).toBe(3);
    expect(usableCpus(2, null)).toBe(2);
  });

  it('keeps a core for the main thread, at least 1 and at most 4 workers', () => {
    expect(defaultBotWorkers(1)).toBe(1);
    expect(defaultBotWorkers(2)).toBe(1);
    expect(defaultBotWorkers(4)).toBe(3);
    expect(defaultBotWorkers(64)).toBe(4);
  });
});
