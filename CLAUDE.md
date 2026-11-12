# Project: Durak Online (Multiplayer Card Game Engine + IS-MCTS AI)

## Overview
A real-time, server-authoritative multiplayer web implementation of the Russian card game **Durak** (36-card deck, supporting 2-6 players, classic "Podkidnoy" rules with optional "Perevodnoy" passing mode) featuring an Information Set Monte Carlo Tree Search (IS-MCTS) AI bot.

## Tech Stack & Monorepo Architecture
- **Language:** Strict TypeScript across all workspaces (`strict: true`, no `any`).
- **Monorepo:** `npm workspaces` (`packages/shared`, `packages/game-engine`, `apps/server`, `apps/web`).
- **Backend:** Node.js, Fastify, Socket.io, Zod (payload validation).
- **Databases:** Redis (active game state & session tokens with TTL), PostgreSQL + Prisma (completed match history & ELO ratings).
- **Frontend:** React 19, Vite, Tailwind CSS, Framer Motion (mobile-first responsive UI).
- **Testing:** Vitest (unit & state-machine edge-case testing).
- **Infrastructure:** Docker Compose for local Redis and PostgreSQL.

## Core Architectural Invariants (NEVER VIOLATE)
1. **Pure Game Engine (`packages/game-engine`):** Must have ZERO external I/O dependencies (no Socket.io, no Redis, no `Date.now()`, no `Math.random()` without an injectable PRNG seed). Every state transition must be a pure function: `applyMove(state, move) -> Result<GameState, GameError>`.
2. **Server-Authoritative & Anti-Cheat:** Never send full `GameState` to clients. Always pass state through `sanitizeStateForPlayer(state, playerId)` before emitting over WebSockets so opponents' hands and undealt deck order remain hidden.
3. **Strict Input Validation:** All incoming Socket.io events in `apps/server` must be validated using shared Zod schemas from `packages/shared` before touching the game engine.
4. **Resilient Reconnection:** Players authenticate to rooms via a persistent `sessionToken`. Disconnecting must not immediately forfeit the game; allow a grace window for reconnection and full state hydration from Redis.

## Rules Specification (as implemented by `packages/game-engine`)
This is the single source of truth for the server, bot and UI. Any change here must be made in `src/rules.ts` / `src/setup.ts` together with `tests/spec.test.ts`.
- **Deck & deal:** 36 cards (6 to Ace, 4 suits). Six cards each, dealt one at a time round-robin starting with seat 0. The bottom card of the stock is the face-up trump and is drawn last. With 6 players the stock is empty after the deal, and the trump card is the last card dealt (it stays publicly known).
- **First attacker:** the holder of the lowest trump. If nobody holds a trump: the holder of the lowest card overall, with equal ranks broken by suit order S, C, D, H. Defender = next seat clockwise (clockwise = increasing seat index).
- **Bout limits:** total attack cards on the table ≤ `firstBoutMaxCards` (default 5) in bout 1 and ≤ `boutMaxCards` (default 6) afterwards. Uncovered cards may never exceed the defender's current hand size, including while the defender is taking.
- **Attacking & throw-in:** only the main attacker may open a bout (with any card). After that, ANY player except the defender who is still in the game may throw in a card whose rank already appears on the table (attack or defense card), at any time, subject to the limits.
- **Defense:** a higher card of the same suit, or any trump against a non-trump. Trump against trump compares by rank. Attack cards may be covered in any order.
- **Take:** the defender only, and only while ≥1 card is uncovered. Throw-ins remain allowed (within limits). The defender picks up every table card, including covered ones.
- **Pass & bout end:** `pass` (non-defenders only) means "done throwing in for now". Any new card on the table (attack, throw-in, defense, transfer) and a `take` clear all passes. The bout ends automatically as soon as (every card is covered OR the defender is taking) AND every non-defender still in the game has either passed or cannot legally throw in. No explicit pass is needed from a player who has no legal throw-in.
- **Transfer (`perevodnoy` mode only):** the defender, before any card is covered and before taking, adds a card whose rank equals the rank of every attack card. The new defender is the next player still in the game clockwise. It is allowed only if the new table size is ≤ the bout limit and ≤ the new defender's hand size. **The transferring player becomes the main attacker** (so they lead the draw order). Passes reset. Transfers may chain. With 2 players the attack bounces back to the original attacker. There is no "show a trump" transfer.
- **After the bout:** beaten → table cards are discarded and the defender attacks next (or, if the defender went out, the next player still in). Taken → the player after the defender attacks next. The new defender is the next player still in after the new attacker.
- **Draw order:** the main attacker first, then the other players clockwise, the defender last; each refills to 6 while the stock lasts.
- **Finishing:** players only go out at the end of a bout. After drawing, if the stock is empty, every player with 0 cards goes out (recorded in seating order starting from the main attacker). When ≤1 player remains the game is over: `durak` = the remaining player, or `null` (a draw) if the last players went out together.
- **Determinism:** a game is fully determined by the seed, player order, config and the sequence of moves.

## Server Architecture (`apps/server`)
Layers, one folder each; dependencies point downward only:
- **`transport/`**: Socket.io handlers. Every incoming event is parsed with its schema from `ClientEventSchemas` before anything else; an invalid payload or unknown event gets an `error` event (`INVALID_PAYLOAD`) and never throws. Every handler is wrapped so an unexpected exception becomes `error {INTERNAL}`. `SocketNotifier` builds every `game:state` per recipient through `sanitizeStateForPlayer` (spectators get the `null` view); there is never one shared payload. Socket.io limits: `maxHttpBufferSize` 16 KB, CORS from `CORS_ORIGINS`.
- **`services/`**: `RoomService` (create/join/leave/resume/start/disconnect) and `GameService` (moves, resync). They use the engine only through `createGame` / `applyMove`; sanitizing happens in transport. The acting `playerId` comes only from the server-side `Session`, never from a payload. Services talk outward through the `RoomNotifier` port (`services/ports.ts`).
- **`repositories/`**: `RoomRepository`, `GameRepository`, `SessionRepository` interfaces (all async), plus in-memory implementations that deep-copy on read and write, as Redis will. Redis (3b) must be a drop-in replacement.

**Per-room serial queue:** every mutation for a room runs inside `KeyedMutex.runExclusive(roomId, …)`: load → validate → apply → save → notify. Broadcasts are sent **inside** the lock, so clients receive versions in order. The mutex is process-local; running more than one server instance requires a distributed lock or sticky room routing (3b).

**Versioning:** `StoredGame.version` starts at 0 and is incremented on every successful move. A `game:move` whose `expectedVersion` ≠ the current version is rejected with `STALE_STATE`, and that player is immediately re-sent their current `game:state`.

**Sessions:** `room:create` / `room:join` issue a `crypto.randomBytes(32)` base64url token mapped to `{ roomId, role, id }`; ids are server-generated. A connection holds at most one session: repeated create/join re-emits the existing session, and joining a different room gives `INVALID_SESSION`. Joining a full lobby or a started game makes you a spectator. When a player's last socket disconnects, the member is marked `connected: false` (no forfeit yet, 3c); `session:resume` reconnects them and re-sends `room:state` + `game:state`. Seeds come from `crypto.randomInt` and are stored with the game.

### Persistence (Phase 3b)
`REPOSITORY=memory|redis` (default: `redis` if `REDIS_URL` is set, else `memory`), `REDIS_URL`, `REDIS_PREFIX` (default `durak:`). `src/backend.ts` builds the backend; `GET /health` reports `{ ok, repository, redis: 'PONG'|'down' }` and returns 503 when Redis is down. Shutdown closes sockets → HTTP → Redis.

| Key | Value | TTL (sliding, reset on every save) |
|---|---|---|
| `${prefix}room:<roomId>` | `{"v":1,"data":Room}` | 6h while lobby/playing, 30m when finished |
| `${prefix}game:<roomId>` | `{"v":1,"data":StoredGame}` | 6h while running, 30m when finished; saving a game also refreshes its room's TTL |
| `${prefix}session:<token>` | `{"v":1,"data":Session}` | 24h, slid forward by `GETEX` on every successful read (`session:resume`) |

- TTL policy lives in `repositories/ttl.ts` and the in-memory store applies it too (entries expire there as well).
- **Validation on read:** values are wrapped in a `{ v: 1, data }` envelope and validated with Zod (`repositories/redis/codec.ts`). Bad JSON, an unknown envelope version or a schema mismatch is logged and returned as `null`, never thrown. The callers already handle `null` (`GAME_NOT_STARTED`, `ROOM_NOT_FOUND`). Bump `ENVELOPE_VERSION` on incompatible format changes.
- **Schema drift guard:** every persisted record has a Zod schema in `repositories/redis/codec.ts`, guarded by `AssertEqual` in `schemaGuards.ts`. When you change a domain type (`Room`, `Session`, `StoredGame`, `GameState`, …), update the schema too; `npm run typecheck` fails until they match exactly.
- **Atomic room + game writes:** any operation that writes or deletes a room and its game together goes through `repos.atomic` (`RoomGameTransaction`: `saveRoomAndGame` / `deleteRoomAndGame`), which is a single `MULTI`/`EXEC` in Redis. Never call `rooms.save` and `games.save` back to back for one logical change.
- **Ghost-connection reset:** on startup (before `listen`) the Redis backend `SCAN`s `${prefix}room:*` (never `KEYS`) and marks every member `connected: false`, preserving TTLs with `KEEPTTL`. Sockets never survive a restart, and a dead process can't emit `disconnect`. Without the reset, rooms would claim players are online forever; the 3c grace timer relies on the flag being truthful.
- **Orphaned sessions:** if `session:resume` finds a valid session whose room is gone, it deletes the session and returns `ROOM_NOT_FOUND`.

> **Single instance only.** `KeyedMutex` is an in-process lock. Running more than one server instance against the same Redis is **NOT supported**: concurrent moves on the same room could interleave. Supporting it requires a distributed per-room lock (e.g. Redis `SET NX PX` with fencing tokens) or sticky routing of each room to one instance.

## Development Workflow & Commands
- Build all workspaces: `npm run build --workspaces`
- Run engine tests: `npm test --workspace=packages/game-engine`
- Run server tests: `npm test --workspace=apps/server` (Redis tests need `docker-compose up -d` or any Redis at `REDIS_URL`; without one they are skipped with a warning)
- Run the server in dev mode: `npm run dev --workspace=apps/server` (env: `PORT`, `HOST`, `CORS_ORIGINS`)
- Start local infrastructure: `docker-compose up -d`

## Implementation Roadmap (Execute Step-by-Step)
- **Phase 1: Foundation & Shared Contracts.** Initialize monorepo, `tsconfig.base.json`, `docker-compose.yml` (Redis + Postgres), and `packages/shared` types + Zod event schemas.
- **Phase 2: Pure Durak Engine & Test Suite.** Build `packages/game-engine` (deck, attack/defense/throw-in validation, draw order, tie-breakers, state sanitizer). Write comprehensive Vitest unit tests covering all edge cases before writing any server code.
- **Phase 3: Real-Time Server & Persistence.** Build `apps/server` with Fastify + Socket.io, Redis room repository, session reconnection logic, and PostgreSQL match persistence. Every `game:move` carries a required `expectedVersion`; reject moves against a stale version.
  - **Turn timers & AFK:**
    - Server owns turn timers. On timeout: defender -> take, non-defender who can throw in -> pass. Engine stays timer-free.
    - Opening attacker timeout: the server auto-plays the attacker's lowest non-trump card (lowest rank; ties broken by suit order S, C, D, H), or the lowest trump if they hold only trumps.
    - If every card is covered, the defender has no pending action (`take` is illegal), so no defender timer runs; the bout only waits on non-defenders.
    - After 2 consecutive timeouts the player is marked AFK and the bot plays on their behalf until they reconnect (until the Phase 4 bot exists, the timeout auto-moves above continue). If the reconnection grace window expires, the player forfeits.
    - Every auto-move (timeout or bot) goes through the same `validateMove` / `applyMove` path as a human move.
- **Phase 4: IS-MCTS AI Bot.** Implement determinized Monte Carlo Tree Search in `packages/game-engine/src/bot` with a configurable thinking time budget (e.g., 300ms per move) and benchmark win rates against a random baseline bot.
- **Phase 5: Mobile-First Web Client.** Build `apps/web` with clean card animations, responsive table layout for 2-6 players, and room invite links.

## Coding Conventions
- Prefer explicit union types and discriminated unions for game phases and move actions.
- Handle errors explicitly via Result objects or custom domain error classes rather than silent failures.
- Every bug fix in `packages/game-engine` must include a regression test in `packages/game-engine/tests/`.