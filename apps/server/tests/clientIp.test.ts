import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  clientIp,
  fastifyTrustProxy,
  NO_PROXY,
  parseTrustedProxies,
  resolveClientIp,
  type ClientIpPolicy,
} from '../src/transport/clientAddress.js';

// Docker's gateway as the app sees cloudflared on the host (published port), from the prod compose
// network's fixed subnet.
const GATEWAY = '172.30.80.1';
const LAN_PEER = '192.168.1.50';

describe('before Phase 10 (evidence): hop trust is not tied to the peer', () => {
  it('with TRUST_PROXY=1 a direct, non-proxy peer can forge its address', () => {
    // A LAN client hitting the port directly (no proxy in between) picks any address it likes.
    expect(clientIp(LAN_PEER, '6.6.6.6', 1)).toBe('6.6.6.6');
  });
});

describe('resolveClientIp with trusted proxies', () => {
  const tunnel: ClientIpPolicy = { trustProxy: 1, trustedProxies: ['172.30.80.0/24', '127.0.0.1/32', '::1/128'], cfConnectingIp: true };

  it('from a trusted proxy peer: CF-Connecting-IP is preferred, then X-Forwarded-For', () => {
    expect(resolveClientIp(GATEWAY, { 'cf-connecting-ip': '79.181.173.179', 'x-forwarded-for': '1.1.1.1' }, tunnel)).toBe(
      '79.181.173.179',
    );
    expect(resolveClientIp(GATEWAY, { 'x-forwarded-for': '6.6.6.6, 79.181.173.179' }, tunnel)).toBe('79.181.173.179');
    expect(resolveClientIp(`::ffff:${GATEWAY}`, { 'cf-connecting-ip': '2001:db8::1' }, tunnel)).toBe('2001:db8::1');
    // An invalid CF header falls back to X-Forwarded-For.
    expect(resolveClientIp(GATEWAY, { 'cf-connecting-ip': 'nonsense', 'x-forwarded-for': '7.7.7.7' }, tunnel)).toBe('7.7.7.7');
  });

  it('from any other peer: forged X-Forwarded-For and CF-Connecting-IP are ignored', () => {
    expect(resolveClientIp(LAN_PEER, { 'x-forwarded-for': '6.6.6.6' }, tunnel)).toBe(LAN_PEER);
    expect(resolveClientIp(LAN_PEER, { 'cf-connecting-ip': '6.6.6.6' }, tunnel)).toBe(LAN_PEER);
    expect(resolveClientIp('::ffff:10.1.2.3', { 'x-forwarded-for': '6.6.6.6' }, tunnel)).toBe('10.1.2.3');
  });

  it('CF-Connecting-IP is opt-in: behind another proxy (Fly) a client could forge it', () => {
    const fly: ClientIpPolicy = { trustProxy: 1, trustedProxies: null, cfConnectingIp: false };
    expect(resolveClientIp('10.0.0.2', { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '79.1.1.1' }, fly)).toBe('79.1.1.1');
  });

  it('two clients through the same trusted proxy are told apart', () => {
    const a = resolveClientIp(GATEWAY, { 'cf-connecting-ip': '1.1.1.1' }, tunnel);
    const b = resolveClientIp(GATEWAY, { 'cf-connecting-ip': '2.2.2.2' }, tunnel);
    expect(a).not.toBe(b);
  });

  it('without trust nothing is forwarded; trustedProxies null keeps the old hop rule', () => {
    expect(resolveClientIp(GATEWAY, { 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2' }, NO_PROXY)).toBe(GATEWAY);
    const legacy: ClientIpPolicy = { trustProxy: 1, trustedProxies: null, cfConnectingIp: false };
    expect(resolveClientIp(LAN_PEER, { 'x-forwarded-for': '6.6.6.6' }, legacy)).toBe('6.6.6.6');
  });
});

describe('Fastify trustProxy for the same policy', () => {
  it('trusts hop 0 only when it is a trusted peer, and at most n hops', () => {
    const trust = fastifyTrustProxy({ trustProxy: 1, trustedProxies: ['172.30.80.0/24'], cfConnectingIp: false });
    if (typeof trust !== 'function') throw new Error('expected a function');
    expect(trust(GATEWAY, 0)).toBe(true);
    expect(trust(LAN_PEER, 0)).toBe(false);
    expect(trust('1.1.1.1', 1)).toBe(false); // beyond the hop count
    expect(fastifyTrustProxy(NO_PROXY)).toBe(false);
    expect(fastifyTrustProxy({ trustProxy: true, trustedProxies: null, cfConnectingIp: false })).toBe(true);
  });
});

describe('config', () => {
  it('parses TRUSTED_PROXIES and TRUST_CF_CONNECTING_IP', () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies(' 172.30.80.0/24, 127.0.0.1 ,::1/128')).toEqual(['172.30.80.0/24', '127.0.0.1', '::1/128']);
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/TRUSTED_PROXIES/);
    expect(() => parseTrustedProxies('docker')).toThrow(/TRUSTED_PROXIES/);
    const config = loadConfig({ TRUST_PROXY: '1', TRUSTED_PROXIES: '172.30.80.0/24', TRUST_CF_CONNECTING_IP: 'true' });
    expect(config.trustedProxies).toEqual(['172.30.80.0/24']);
    expect(config.trustCfConnectingIp).toBe(true);
    expect(loadConfig({}).trustCfConnectingIp).toBe(false);
  });
});
