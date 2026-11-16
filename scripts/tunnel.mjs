// Play with friends: the production stack behind a Cloudflare Quick Tunnel.
//
//   npm run tunnel             (Ctrl+C stops the tunnel; the stack keeps running until `npm run prod:down`)
//
// 1. `docker compose -f docker-compose.prod.yml up -d --build` with TRUST_PROXY=1 and the port bound
//    to 127.0.0.1 only;
// 2. waits for /health locally, then starts `cloudflared tunnel --url http://127.0.0.1:<port>`;
// 3. waits until the public https://*.trycloudflare.com URL answers /health and prints it.
//
// Why TRUST_PROXY=1: every request reaches the app from cloudflared (through Docker's port
// forwarding), so without trust every friend would share one IP and the per-IP limits (sockets,
// rooms per hour) would apply to all of them together. Cloudflare's edge APPENDS the real client
// address to X-Forwarded-For and cloudflared adds nothing, so the app sees
// "[anything the client sent...], <real client>" from one trusted hop: trusting exactly 1 hop picks
// the real client, and a forged X-Forwarded-For only lands in the ignored part. Binding to
// 127.0.0.1 keeps anyone on the LAN from bypassing the tunnel with a forged header.
// The compose file also limits header trust to its own Docker network (TRUSTED_PROXIES), and
// TRUST_CF_CONNECTING_IP prefers the CF-Connecting-IP header Cloudflare's edge sets (falling back
// to the X-Forwarded-For hop rule when it is absent).
import { spawn, spawnSync } from 'node:child_process';

const port = process.env.APP_PORT ?? '8080';
const local = `http://127.0.0.1:${port}`;
const log = (msg) => console.log(`[tunnel] ${msg}`);
const fail = (msg) => {
  console.error(`[tunnel] ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not up yet (or DNS for a fresh tunnel hostname not propagated yet)
    }
    await sleep(1500);
  }
  return false;
}

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status !== 0) {
  fail('cloudflared not found on PATH (Windows: winget install --id Cloudflare.cloudflared)');
}

log('starting the production stack (TRUST_PROXY=1, CF-Connecting-IP, bound to 127.0.0.1)...');
const up = spawnSync('docker', ['compose', '-f', 'docker-compose.prod.yml', 'up', '-d', '--build'], {
  stdio: 'inherit',
  env: { ...process.env, TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: 'true', APP_BIND: '127.0.0.1' },
});
if (up.status !== 0) fail('docker compose up failed (is Docker running?)');
if (!(await waitHealthy(local, 90_000))) fail(`${local}/health did not become healthy`);
log(`stack healthy at ${local}`);

const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let publicUrl = null;
let ready = false;
const onOutput = (chunk) => {
  const text = chunk.toString();
  if (process.env.TUNNEL_VERBOSE) process.stderr.write(text);
  publicUrl ??= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', (code) => {
  if (!ready) fail(`cloudflared exited (${code}) before the tunnel was ready; rerun with TUNNEL_VERBOSE=1`);
  log(`cloudflared exited (${code})`);
  process.exit(code ?? 0);
});

const stop = () => {
  log('stopping the tunnel. The stack is still running: `npm run prod:down` stops it.');
  tunnel.kill();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const urlDeadline = Date.now() + 60_000;
while (!publicUrl && Date.now() < urlDeadline) await sleep(250);
if (!publicUrl) {
  tunnel.kill();
  fail('no trycloudflare.com URL from cloudflared within 60 s; rerun with TUNNEL_VERBOSE=1');
}
log(`tunnel created, waiting for ${publicUrl} to answer...`);
if (!(await waitHealthy(publicUrl, 90_000))) {
  tunnel.kill();
  fail(`${publicUrl}/health is not reachable`);
}
ready = true;

console.log(`
  ┌──────────────────────────────────────────────────────────────────────┐
    Share this link with your friends:

      ${publicUrl}

    Ctrl+C stops the tunnel (the URL is gone for good; a rerun gets a new one).
    Stop the stack afterwards: npm run prod:down
  └──────────────────────────────────────────────────────────────────────┘
`);
