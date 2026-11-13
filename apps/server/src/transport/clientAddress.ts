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
