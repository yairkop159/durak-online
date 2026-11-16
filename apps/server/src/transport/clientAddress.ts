import { BlockList, isIP } from 'node:net';

/**
 * Reverse-proxy trust, same meaning as Fastify's `trustProxy`:
 * - false: the socket's peer address is the client;
 * - n (hops): the n closest X-Forwarded-For entries were appended by our own proxies, so the
 *   client is the entry just before them (platform proxies such as Fly, Render or Railway: 1);
 * - true: trust every hop, the leftmost entry is the client (spoofable unless the proxy
 *   strips client-supplied headers; prefer a hop count).
 */
export type TrustProxy = boolean | number;

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`Invalid TRUST_PROXY: ${raw} (false, true or a hop count)`);
  return hops;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/** The client address of a connection, honoring `trust` for X-Forwarded-For. */
export function clientIp(
  peerAddress: string,
  forwardedFor: string | string[] | undefined,
  trust: TrustProxy,
): string {
  const peer = normalizeIp(peerAddress);
  const header = firstHeader(forwardedFor);
  if (trust === false || trust === 0 || !header) return peer;
  // Nearest last: [client, proxy1, ..., proxyN-1, peer].
  const chain = [
    ...header
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    peer,
  ].map(normalizeIp);
  if (trust === true) return chain[0] ?? peer;
  return chain[Math.max(0, chain.length - 1 - trust)] ?? peer;
}

/**
 * Who may act as our reverse proxy (Phase 10). A hop count alone trusts X-Forwarded-For from ANY
 * peer, so anyone who can reach the port directly could forge their address. With
 * `trustedProxies` set, forwarded headers count only when the socket peer itself is in that list
 * (e.g. the Docker network the tunnel / platform proxy connects from); any other peer is the client.
 */
export interface ClientIpPolicy {
  readonly trustProxy: TrustProxy;
  /** CIDRs / addresses of the proxy peer; null = any peer (the pre-Phase-10 behaviour). */
  readonly trustedProxies: readonly string[] | null;
  /**
   * Prefer Cloudflare's CF-Connecting-IP from a trusted peer. Opt-in: only safe when Cloudflare is
   * really in front (its edge overwrites the header); behind another proxy a client could forge it.
   */
  readonly cfConnectingIp: boolean;
}

export const NO_PROXY: ClientIpPolicy = { trustProxy: false, trustedProxies: null, cfConnectingIp: false };

/** "10.0.0.0/8, 127.0.0.1, ::1/128" → validated entries; empty → null (any peer). */
export function parseTrustedProxies(raw: string | undefined): string[] | null {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (!addToBlockList(new BlockList(), entry)) throw new Error(`Invalid TRUSTED_PROXIES entry "${entry}" (CIDR or IP)`);
  }
  return entries;
}

function addToBlockList(list: BlockList, entry: string): boolean {
  const [address = '', prefixRaw] = entry.split('/');
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (prefixRaw === undefined) {
    list.addAddress(address, type);
    return true;
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) return false;
  list.addSubnet(address, prefix, type);
  return true;
}

/** A matcher for the policy's proxy peers (built once per server). */
export function proxyPeerMatcher(trustedProxies: readonly string[] | null): (peer: string) => boolean {
  if (trustedProxies === null) return () => true;
  const list = new BlockList();
  for (const entry of trustedProxies) addToBlockList(list, entry);
  return (peer) => {
    const ip = normalizeIp(peer);
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

/**
 * The client address of a connection or request under `policy`: the peer itself unless it is a
 * trusted proxy; from a trusted proxy, CF-Connecting-IP (when enabled and a valid IP), else the
 * X-Forwarded-For entry `trustProxy` hops back.
 */
export function resolveClientIp(
  peerAddress: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  policy: ClientIpPolicy,
  isProxyPeer: (peer: string) => boolean = proxyPeerMatcher(policy.trustedProxies),
): string {
  const peer = normalizeIp(peerAddress);
  if (policy.trustProxy === false || policy.trustProxy === 0 || !isProxyPeer(peer)) return peer;
  if (policy.cfConnectingIp) {
    const cf = singleHeader(headers['cf-connecting-ip']);
    if (cf !== undefined && isIP(cf) !== 0) return normalizeIp(cf);
  }
  return clientIp(peer, headers['x-forwarded-for'], policy.trustProxy);
}

/**
 * Fastify's `trustProxy` for the same policy: hop 0 (the socket peer) must be a trusted proxy
 * peer, and at most `trustProxy` hops are trusted.
 */
export function fastifyTrustProxy(policy: ClientIpPolicy): boolean | ((address: string, hop: number) => boolean) {
  const { trustProxy } = policy;
  if (trustProxy === false || trustProxy === 0) return false;
  if (trustProxy === true && policy.trustedProxies === null) return true;
  const isProxyPeer = proxyPeerMatcher(policy.trustedProxies);
  const hops = trustProxy === true ? Number.POSITIVE_INFINITY : trustProxy;
  return (address, hop) => hop < hops && (hop > 0 || isProxyPeer(address));
}

/** "::ffff:1.2.3.4" → "1.2.3.4", so IPv4 clients count once whichever stack accepted them. */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Socket.io handshake Origin check (WebSockets are not covered by CORS). Allowed: no Origin
 * (non-browser clients), an origin from `allowed`, or the server's own origin (same host).
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
