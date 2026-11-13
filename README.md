# Durak Online

A real-time multiplayer web version of **Durak**, the Russian card game, with a server-authoritative
game server and an **IS-MCTS** (Information Set Monte Carlo Tree Search) computer opponent that plays
without seeing hidden cards.

- 36-card deck, 2–6 players, classic *Podkidnoy* rules plus an optional *Perevodnoy* (transfer) mode
- Play with friends via invite links, or against bots at three difficulty levels
- Mobile-first Hebrew (RTL) UI with card animations
- Strict TypeScript end to end, 490+ tests, including a randomized fuzz harness

## Screenshots

> _Screenshots coming soon._
>
> <!-- ![Lobby](docs/screenshots/lobby.png) ![Table](docs/screenshots/table.png) ![Game over](docs/screenshots/game-over.png) -->

## Features

- **Rooms and invite links:** create a room, share `/room/<id>`, and late joiners become spectators.
- **Bots:** easy (greedy heuristic with some randomness), medium (IS-MCTS, 200 iterations) and
  hard (IS-MCTS, 300 ms per move). "Play vs computer" starts a game against a bot in one click.
- **Turn timers and AFK handling:** the server auto-plays a timed-out turn. After two timeouts in a
  row a bot takes over the seat until the player comes back.
- **Reconnection:** a reload or a dropped connection keeps your seat. You have a grace window to
  come back before forfeiting, and the full state is restored from Redis.
- **Rematch:** everyone returns to the same lobby after a game.
- **Abuse limits:** per-socket rate limiting, rooms per IP, sockets per IP, a cap on stored rooms.

## Architecture

An npm-workspaces monorepo:

```
packages/
  shared/        Types and Zod schemas for every Socket.io event (the client/server contract)
  game-engine/   Pure rules engine + the bot library (no I/O, no clocks, seeded PRNG)
apps/
  server/        Node.js, Fastify, Socket.io, Redis; serves the built web client too
  web/           React 19, Vite, Tailwind CSS v4, Framer Motion
```

**Engine (`packages/game-engine`).** Every state transition is a pure function:
`applyMove(state, move) -> Result<GameState, GameError>`. There is no `Date.now()` and no
`Math.random()`. A game is fully determined by its seed, the player order, the config and the move
sequence, which makes bugs reproducible and the bot's simulations cheap. Timeouts and resignation are
pure functions too; the server owns the timers.

**Server (`apps/server`).** Strict layering: `transport/` (Socket.io handlers) → `services/`
(rooms, games, timers, bot driver) → `repositories/` (in-memory or Redis, behind the same async
interfaces). The bot runs on a `worker_threads` pool so a 300 ms search never blocks the event loop.

**Web (`apps/web`).** A single `GameClient` feeds server events into a store with a pure reducer.
Legal moves are computed on the client from the sanitized view, using the same engine code as the
server, so the UI highlights exactly the cards you may play.

**Bot (`packages/game-engine/src/bot`).** Single-Observer IS-MCTS (Cowling, Powley & Whitehouse,
2012), described below.

## Key engineering decisions

### Server-authoritative, nothing hidden leaves the server
Clients send intents; the server validates them with the engine and broadcasts the result. Every
`game:state` is built per recipient through `sanitizeStateForPlayer(state, playerId)`, so opponents'
hands and the order of the stock never reach a browser. Every incoming event is parsed with a shared
Zod schema before anything else runs, and the acting player always comes from the server-side
session, never from the payload.

### A pure engine
Keeping I/O out of the engine made it testable in isolation (rules, fuzzing, property tests) and
let the same code run on the server, in the browser (legal-move highlighting) and inside the bot's
simulations.

### Versioning and a per-room serial queue
Every room mutation (human move, bot move, timeout, forfeit) runs inside a per-room mutex:
load → validate → apply → save → broadcast. Each game has a `version`, and every `game:move` carries
the `expectedVersion` the client saw; a stale move is rejected and the client is re-sent the current
state. Broadcasts happen inside the lock, so clients always receive versions in order. All writes go
through one `GameCommitter`, and room + game changes are saved atomically (`MULTI`/`EXEC` in Redis).

### IS-MCTS that cannot cheat
The bot receives only what a human gets: its sanitized `PlayerView` plus `PublicKnowledge`, a
JSON record of facts it can prove from what it has seen (the discard pile, cards opponents picked up
with a take, where the face-up trump went). Each search iteration samples one possible world
(a *determinization*) consistent with that information, then runs a tree search over the bot's
information sets with a greedy rollout policy.

This is enforced by tests, not by convention: an import-graph test fails if any view-only bot file
imports full game state, no bot file may call the sanitizer, and the jobs sent to worker threads are
checked to contain no hidden card.

### Tests
- **Rules spec tests** pin down every rule in the specification (deal, first attacker, bout limits,
  throw-ins, transfers, draw order, finishing, draws).
- **Fuzz harness:** 400 random games (2–6 players × both modes) check the state invariants on every
  step, and check that the client-side `getLegalMovesForView(view)` equals the server's
  `getLegalMoves(state, player)` for every player.
- **Bot property tests:** every sampled world must re-sanitize to exactly the bot's view, and
  `PublicKnowledge` is checked against the real state on every step for every seat.
- **Server tests** use an injected clock and scheduler (no real sleeps) and run against both the
  in-memory and Redis repositories. Socket tests cover concurrency, security (no leaked hands),
  reconnection, timers and rate limits.
- **Web tests:** Vitest + Testing Library, including a session test against a real in-process server.
- `npm test` runs each workspace with a hard time limit, so a test run can never hang.

### Benchmark results
`npm run bench --workspace=packages/game-engine` plays one IS-MCTS seat against Greedy opponents with
fixed seeds, rotating the IS-MCTS seat. Two-player results (100 games per row; lower durak rate is
better):

| Mode | Budget | IS-MCTS durak rate | Greedy durak rate |
|---|---|---|---|
| Podkidnoy | 544 iterations (≈300 ms) | **23%** | 75% |
| Perevodnoy | 544 iterations (≈300 ms) | **14%** | 77% |
| Podkidnoy | 300 ms real time | **16%** | 81% |
| Perevodnoy | 300 ms real time | **16%** | 81% |

The remaining games were draws. In every row the 95% Wilson confidence intervals don't overlap.
Results depend on the machine (the iteration count is calibrated to ≈300 ms first).

## Running locally

Requirements: Node.js 20+ (24 recommended), Docker (for Redis).

```bash
npm install
docker compose up -d          # Redis (and Postgres) for local development
npm run dev                   # server on :3000 + web on http://localhost:5173
```

Without Redis the server falls back to in-memory storage (state is lost on restart).

Tests, typecheck and the benchmark:

```bash
npm run typecheck
npm test                                        # every workspace (Redis tests skip if Redis is down)
npm run bench --workspace=packages/game-engine  # bot benchmark (-- --full, -- --realtime)
```

The production image (one process serves the web client and Socket.io on one origin):

```bash
npm run prod:up               # http://localhost:8080
npm run smoke -- http://localhost:8080
npm run prod:down
```

To play with friends from your machine, `npm run tunnel` starts the production stack behind a
Cloudflare Quick Tunnel and prints a public `https://*.trycloudflare.com` URL. Deployment notes
(Fly.io and others) are in [`DEPLOY.md`](DEPLOY.md) (Hebrew).

## License

[MIT](LICENSE) © Yair
