// End-to-end smoke test against a running server (e.g. the production image).
//
//   node scripts/smoke.mjs [baseUrl] [moves]      default: http://localhost:8080, 12 moves
//
// Requires a built game-engine (npm run build). Acts like a browser on that origin:
// 1. GET /health and the SPA (/room/<id> must return index.html, its JS/CSS assets must load);
//    the profiles API (Phase 10): with postgres "ok", GET /api/leaderboard must answer 200 with
//    entries; otherwise it must answer 503 RATINGS_UNAVAILABLE (games run without Postgres);
// 2. Socket.io with a same-origin Origin header: create a room, add a medium bot (IS-MCTS on the
//    server's worker threads), start the game, then play `moves` of our own legal moves (from
//    getLegalMovesForView, as the web client does) while the bot answers.
// Exits non-zero on any failure.
import { getLegalMovesForView } from '@durak/game-engine';
import { io } from 'socket.io-client';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const targetMoves = Number(process.argv[3] ?? 12);
const TIMEOUT_MS = 15_000;

const log = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- HTTP
const health = await fetch(`${base}/health`).catch((e) => fail(`GET /health: ${e.message}`));
const healthBody = await health.json();
if (!health.ok || !healthBody.ok) fail(`/health ${health.status} ${JSON.stringify(healthBody)}`);
log(`/health -> ${health.status} ${JSON.stringify(healthBody)}`);

const page = await fetch(`${base}/room/smoke123`);
const html = await page.text();
if (!page.ok || !html.includes('<div id="root">')) fail(`/room/smoke123 did not return the SPA (${page.status})`);
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (assets.length === 0) fail('index.html references no /assets files');
for (const asset of assets) {
  const res = await fetch(`${base}${asset}`);
  if (!res.ok) fail(`GET ${asset} -> ${res.status}`);
  await res.arrayBuffer();
}
log(`SPA fallback ok for /room/smoke123; ${assets.length} assets load (${assets.join(', ')})`);

const board = await fetch(`${base}/api/leaderboard`).catch((e) => fail(`GET /api/leaderboard: ${e.message}`));
const boardBody = await board.json().catch(() => fail('/api/leaderboard did not return JSON'));
if (healthBody.postgres === 'ok') {
  if (board.status !== 200 || !Array.isArray(boardBody.entries)) fail(`/api/leaderboard ${board.status} ${JSON.stringify(boardBody)}`);
  log(`/api/leaderboard -> 200 (${boardBody.entries.length} entries)`);
} else {
  if (board.status !== 503 || boardBody.error !== 'RATINGS_UNAVAILABLE') fail(`/api/leaderboard ${board.status} ${JSON.stringify(boardBody)}`);
  log(`/api/leaderboard -> 503 RATINGS_UNAVAILABLE (postgres: ${healthBody.postgres ?? 'n/a'}; games still run)`);
}

// ---------------------------------------------------------------- Socket.io
const socket = io(base, { transports: ['websocket'], extraHeaders: { origin: base }, reconnection: false });
const events = [];
const waiters = new Set();
socket.onAny((event, payload) => {
  events.push({ event, payload });
  if (event === 'error' && payload?.code !== 'STALE_STATE') log(`server error: ${JSON.stringify(payload)}`);
  for (const w of [...waiters]) w();
});

function waitFor(event, predicate = () => true, since = 0) {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (let i = since; i < events.length; i++) {
        const e = events[i];
        if (e.event === event && predicate(e.payload)) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(e.payload);
          return true;
        }
      }
      return false;
    };
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timed out waiting for ${event}`));
    }, TIMEOUT_MS);
    if (!check()) waiters.add(check);
  });
}

await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
}).catch((e) => fail(e.message));
log(`socket connected (${socket.io.engine.transport.name})`);

try {
  socket.emit('room:create', { nickname: 'smoke', maxPlayers: 2, config: {} });
  const session = await waitFor('session:issued');
  const { roomId, playerId } = session;
  log(`room ${roomId} created, I am ${playerId}`);

  socket.emit('room:addBot', { roomId, difficulty: 'medium' });
  await waitFor('room:state', (r) => r.members.length === 2 && r.members.some((m) => m.isBot));
  log('medium bot seated');

  socket.emit('game:start', { roomId });
  let state = await waitFor('game:state', (s) => s.version === 0);
  log(`game started (trump ${state.view.trumpSuit}, ${state.view.deckCount} cards in the stock)`);

  let myMoves = 0;
  const started = Date.now();
  while (myMoves < targetMoves) {
    if (state.view.phase.kind === 'finished') break;
    const legal = getLegalMovesForView(state.view);
    if (legal.length === 0) {
      // Not our turn: wait for the bot (or the bout to resolve).
      const since = events.length;
      state = await waitFor('game:state', (s) => s.version > state.version, since);
      continue;
    }
    const pick =
      legal.find((m) => m.type === 'defend') ??
      legal.find((m) => m.type === 'attack') ??
      legal.find((m) => m.type === 'pass') ??
      legal[0];
    const since = events.length;
    socket.emit('game:move', { roomId, move: pick, expectedVersion: state.version });
    const next = await waitFor('game:state', (s) => s.version > state.version, since);
    myMoves++;
    log(`v${state.version} -> v${next.version}: ${pick.type}${pick.card ? ` ${pick.card.rank}${pick.card.suit}` : ''}`);
    state = next;
  }
  const latest = events.filter((e) => e.event === 'game:state').at(-1).payload;
  const botMoves = latest.version - myMoves;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`played ${myMoves} moves; the bot made ${botMoves}; version ${latest.version}; ${secs}s`);
  if (botMoves < 1 && latest.view.phase.kind !== 'finished') fail('the bot never moved');

  socket.emit('room:leave', { roomId });
  log('PASS');
} catch (error) {
  fail(error.message);
} finally {
  socket.disconnect();
}
process.exit(0);
