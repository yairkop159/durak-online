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
- **Infrastructure:** Docker Compose for local Redis and PostgreSQL (`docker-compose.yml`); one production image (`Dockerfile`) and `docker-compose.prod.yml` (app + Redis). See "Production" below.

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
- **`lastBout`:** every bout resolution stores `{ table, outcome: 'beaten' | 'taken', defenderId }` with the final table (including a closing defense/throw-in that ended the bout inside the same move). It is public (copied into `PlayerView`), is not a card location, and is kept until the next bout resolves (`null` before the first). The client animates resolutions from it. `src/viewInference.ts` explains a resolution from two consecutive views (`inferBoutResolution`: the closing card, who could have closed it, how many cards each player drew). It is shared by the web animations (`apps/web/src/anim/diffViews.ts`) and the bot's `PublicKnowledge`.
- **Draw order:** the main attacker first, then the other players clockwise, the defender last; each refills to 6 while the stock lasts.
- **Finishing:** players only go out at the end of a bout. After drawing, if the stock is empty, every player with 0 cards goes out (recorded in seating order starting from the main attacker). When ≤1 player remains the game is over: `durak` = the remaining player, or `null` (a draw) if the last players went out together.
- **Determinism:** a game is fully determined by the seed, player order, config and the sequence of moves.
- **Legal moves from a view:** `getLegalMovesForView(view)` (`src/viewMoves.ts`) computes the viewer's legal moves from the sanitized `PlayerView` alone (used by the web client and test bots). It must equal `getLegalMoves(state, p)` without `playerId`, for every player and every reachable state; the fuzz harness (`tests/fuzz.test.ts`) checks this on every step. Any rule change must update both.
- **Timeouts & resignation** (`src/timeout.ts`, pure; the engine has no timers):
  - `getTimeoutMoves(state)`: `awaitingAttack` → the attacker opens with the lowest non-trump (lowest rank, ties S, C, D, H), or the lowest trump if they hold only trumps. `bout` → the defender `take`s if a card is uncovered and they aren't already taking, then every non-defender who can still throw in and hasn't passed `pass`es, in seat order from the main attacker. `getAwaitedPlayers` = the players those moves belong to.
  - `applyTimeout(state)` applies them in order, each through `applyMove`, skipping any that an earlier one made obsolete. Each call opens a bout or ends the current one (it is never a no-op).
  - **Known limitation:** timeouts alone can cycle forever. Each take leaves the taker above 6 cards, so nobody draws (even with cards still in the stock), nothing is discarded, and one card circulates around the table. A regression test pins this down; the server's abandon guard handles it.
  - `resign(state, playerId)` → finished, durak = that player. `abandon(state)` → finished, durak = `null`. Both append everyone still in to `finishOrder` and leave the cards untouched.

## Server Architecture (`apps/server`)
Layers, one folder each; dependencies point downward only:
- **`transport/`**: Socket.io handlers. Every incoming event is parsed with its schema from `ClientEventSchemas` before anything else; an invalid payload or unknown event gets an `error` event (`INVALID_PAYLOAD`) and never throws. Every handler is wrapped so an unexpected exception becomes `error {INTERNAL}`. `SocketNotifier` builds every `game:state` per recipient through `sanitizeStateForPlayer` (spectators get the `null` view); there is never one shared payload. Socket.io limits: `maxHttpBufferSize` 16 KB, CORS from `CORS_ORIGINS`, an Origin check on the handshake, and the abuse limits in "Production" (rate limiting runs in `socket.use`, before validation).
- **`services/`**:
  - `RoomService` (create/join/leave/resume/start/disconnect, add/remove bot) and `GameService` (moves, bot moves, resync).
  - `GameCommitter` is the single write path for new game versions (see "Bots in games").
  - `BotDriver` plays bot seats and AFK humans.
  - The acting `playerId` comes only from the server-side `Session`, never from a payload. For bot moves it comes from the BotDriver's own plan.
  - Services talk outward through the `RoomNotifier` and `GameChangeListener` ports (`services/ports.ts`).
  - Views sent to clients are sanitized only in transport. `GameCommitter` and `BotDriver` also call `sanitizeStateForPlayer`, but only to build bot knowledge and bot jobs. Those views never leave the process.
- **`bot/`**: bot decisions: the `BotJob` type, `decide`, the worker pool and the in-process runner. No game state, no repositories.
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
- **Atomic room + game writes:** any operation that writes or deletes a room and its game together goes through `repos.atomic` (`RoomGameTransaction`: `saveRoomAndGame` / `saveRoomDeleteGame` / `deleteRoomAndGame`), which is a single `MULTI`/`EXEC` in Redis. Never call `rooms.save` and `games.save` back to back for one logical change.
- **Ghost-connection reset:** on startup (before `listen`) the Redis backend `SCAN`s `${prefix}room:*` (never `KEYS`) and marks every member `connected: false`, preserving TTLs with `KEEPTTL`. Sockets never survive a restart, and a dead process can't emit `disconnect`. Without the reset, rooms would claim players are online forever; the 3c grace timer relies on the flag being truthful.
- **Orphaned sessions:** if `session:resume` finds a valid session whose room is gone, it deletes the session and returns `ROOM_NOT_FOUND`.
- **Rematch (`room:rematch`):** any seated player of a `finished` room puts it back to `lobby` (same members, `afk`/`consecutiveTimeouts`/`graceDeadline` reset; offline members keep their seat and can resume) and the finished game is deleted, atomically via `repos.atomic.saveRoomDeleteGame`. In the lobby it is a no-op that re-sends `room:state` (idempotent: everyone may press "back to lobby"); while playing → `GAME_IN_PROGRESS`; spectators → `NOT_IN_ROOM`.

### Bots in games (Phase 4b)
**Seats.**
- `RoomMember.isBot: boolean` and `botDifficulty: 'easy' | 'medium' | 'hard' | null`. Both are public in `room:state`.
- Bot seats are built only by `newBotMember`. They are always `connected`, never AFK, never get a grace period, and have no session or socket. The ghost reset, `rearmAll` graces and `markDisconnected` all skip them.
- `room:addBot { roomId, difficulty }` and `room:removeBot { roomId, playerId }` are host only and lobby only. They can fail with `NOT_HOST`, `GAME_IN_PROGRESS`, `ROOM_FULL` or `NOT_A_BOT`. Server nicknames are `Bot N`; the web shows "מחשב N".
- A room always has a human:
  - The host is human, and host transfer skips bots.
  - A lobby whose last human leaves is deleted.
  - `game:start` with no human gives `NO_HUMANS`.

**Difficulties** (`bot/job.ts`, `DEFAULT_BOT_POLICIES`):
- easy = GreedyBot, with a uniformly random legal move 15% of the time.
- medium = IS-MCTS, 200 iterations.
- hard = IS-MCTS, 300 ms (`thinkMs`; the worker's clock).
- The AFK takeover plays at medium.

**`GameCommitter` (single write path).** Every new version goes through `commit(...)` inside the room lock: human moves, bot moves, timeouts and forfeits (`start(...)` covers version 0). It does, in order:
1. `version + 1`.
2. Update every seat's knowledge: `updateKnowledge(k ?? initKnowledge(prevView), prevView, nextView)`, using the views that player receives.
3. The bots-only fast-forward.
4. The deadline.
5. Save (atomic if the room changed).
6. Broadcast.
7. Arm or cancel the timer.
8. `GameChangeListener.onGameChanged(room, game, prevState)`.

`announce(...)` notifies the listener without a new version (resume, startup). Never write a game version anywhere else.

**Data:**
- `StoredGame.knowledge: Record<PlayerId, PublicKnowledge>` covers every seat, humans included, because of the AFK takeover. A missing entry is rebuilt with `initKnowledge`, which is sound.
- `StoredGame.botAssisted: PlayerId[]` lists the humans a bot ever moved for. It is sent in `game:over`, for Phase 3d ratings.
- The codec defaults (`{}`, `[]`, `botDifficulty: null`) let older records decode.

**BotDriver** (`services/BotDriver.ts`). There is one entry per `(room, seat)`: `thinking` → `ready` → `applying`, or dropped.
- **When it plans.** On every `onGameChanged` it plans only for `canonicalActor(state)` (the engine's turn order, the same one IS-MCTS assumes), and only if that seat is controlled and has a legal move. Controlled means a bot seat, or a human with `afk` while `afkTakeover` is on (default).
- **The job.** It is built inside the lock from that exact version: `sanitizeStateForPlayer(state, seat)` plus `game.knowledge[seat]`. A newer change aborts every older entry in the room. Queued jobs are dropped and running results are ignored. A duplicate notification for the same seat and version is a no-op.
- **Pacing.**
  - The move is applied at `max(change time + delay, job done)`.
  - delay = `800 + r·700` ms after an ordinary move.
  - delay = `1300 + r·500` ms after a bout resolution (`boutNumber` changed or the table was cleared), so the client's ≤1.2 s resolution animation finishes first.
  - `r` comes from server-side randomness (injectable). The engine stays pure.
- **Applying.** `GameService.applyAutomatedMove(roomId, playerId, move, expectedVersion = planned version)` uses the same lock, version check and `applyMove` as a human move.
  - It requires the seat to still be bot-controlled.
  - It does NOT reset `timeoutStreak`, `afk` or `consecutiveTimeouts`.
  - `STALE_STATE` is dropped silently: the newer version already planned for itself, so the version rises exactly once per move.
- **AFK hand-back.** A human `game:move` or `session:resume` clears `afk`. The resulting `onGameChanged`/`announce` aborts that seat's entry.
- **Timers.** The turn timer stays as the last resort. `deadlineFor` treats bot seats like AFK seats (5 s if every awaited player is a bot or AFK), and expiries never mark bots AFK.
- **Bots-only fast-forward.** When every player still in is a bot (all humans went out), `commit` plays the rest at once inside the lock. Each seat uses GreedyBot on its own view. There is one version bump, and `endReason` is `'normal'`, or `'abandoned'` after 3000 moves.
- **Startup.** `rearmAll` calls `announce` for every running game, from the persisted knowledge.

**Worker pool** (`bot/WorkerPoolRunner.ts`):
- `worker_threads`, size `BOT_WORKERS` (default `defaultBotWorkers()` in `bot/cpus.ts`: usable CPUs − 1, between 1 and 4, where usable CPUs honors the container's cgroup quota), spawned lazily, FIFO queue.
- Jobs are plain `BotJob { jobId, view, knowledge, options: { seed, policy } }`. They never carry a `GameState`; a test asserts that no serialized job contains a hidden card.
- Per-job timeout `BOT_JOB_TIMEOUT_MS` (2000), from submission, on the injected `Scheduler`. On a timeout, worker `error`/`exit`, or a result that fails `ClientMoveSchema`, the job resolves with GreedyBot on the main thread, and a stuck or dead worker is replaced.
- The worker loads `botWorker.ts` under tsx (adding `--import tsx` if needed) or `botWorker.js` from dist. It imports `@durak/game-engine` through its package entry, so `npm run dev` (which builds the engine first) is required.
- `buildServer({ botRunner, botSettings })` injects the runner and the settings. Tests use `InProcessRunner` (synchronous, records serialized jobs), small iteration budgets and a fixed pacing `random`. The service harness defaults `afkTakeover: false` so the 3c timer tests keep observing raw timeouts.

> **Single instance only.** `KeyedMutex` is an in-process lock. Running more than one server instance against the same Redis is **NOT supported**: concurrent moves on the same room could interleave. Supporting it requires a distributed per-room lock (e.g. Redis `SET NX PX` with fencing tokens) or sticky routing of each room to one instance.

## Web Client (`apps/web`)
React 19 + Vite + Tailwind v4, Hebrew UI (`dir="rtl"`). `@durak/shared` and `@durak/game-engine` are aliased to their `src/` (no prebuild for dev, tests or `vite build`).
- **Routes:** `/` (home: nickname, player count, mode → `room:create`) and `/room/:id` (join prompt / lobby / table / game-over overlay / room not found). Tiny router in `src/routing.ts` (History API).
- **`src/net/`:** `Transport` (socket.io-client wrapper; tests use `FakeTransport`), `GameClient` (the single connection: feeds server events into the store, owns session tokens, exposes actions), `Store` + pure `reducer` read via `useSyncExternalStore`. Every `game:move` carries `expectedVersion` = the last received `game:state` version. `STALE_STATE` errors are swallowed (the server re-sends the state). A `game:state` older than the held version is ignored. `room:state` with status `lobby` clears the game (rematch).
- **Sessions:** tokens are kept in **`sessionStorage`** (`durak:sessions` = `{ roomId: token }`), NOT `localStorage`, so every tab is its own seat (two windows of one browser = two players). A reload keeps the seat: on every (re)connect, the room in the URL is resumed with `session:resume`. **Every new socket must resume, socket.io's automatic reconnects included:** the server binds sessions per socket, so the store's `bound` flag is cleared on every disconnect and set by `session:issued`. `session:resume` is the first event on a new socket. Moves and other session actions are dropped while `!canAct(state)` (disconnected or resuming), never buffered: socket.io would flush them before the resume, and they would hit `NOT_IN_ROOM`. Regression tests: `tests/reconnect.test.tsx`, and a real-server TCP-relay cut in `tests/sessions.test.ts`. A `NOT_IN_ROOM` while holding a session means the server lost this socket's binding: the client marks itself unbound and resumes, which resends room + game state. No toast is shown, and only one resume runs at a time. While `isReconnecting(state)` (in a room and `!canAct`, or a resume pending), the `ConnectionBanner` shows "מתחבר מחדש...", `<main>` is `inert`, and the table offers no moves. **Trade-off:** closing the tab forgets the token, so that seat is forfeited once `RECONNECT_GRACE_MS` expires. A rejected token (`INVALID_SESSION` / `ROOM_NOT_FOUND`) is deleted and the join prompt (or "room not found") is shown. A connection holds one session, so switching rooms reconnects the socket first.
- **Bots (4b):**
  - The host's lobby has a difficulty picker plus "add bot", and bot rows have a remove button.
  - Bot seats show `BotPill` (🤖 + difficulty) and a localized name (`displayName`).
  - An AFK human's seat shows "הבוט משחק במקומך" / "בוט משחק".
  - Home's "play vs computer" is a `GameClient.playVsComputer` intent: `room:create` (2 seats) → `room:addBot` on our 1-member lobby → `game:start` once the bot is seated. Any error or leaving cancels it.
- **Table interaction (`src/game/selection.ts`, pure):** legal moves come from `getLegalMovesForView`; legal hand cards are highlighted, others dimmed. Attack/throw-in = one click. Defend = hand card then attack card, or attack card then hand card. Transfer = hand card then the "transfer" slot. Selection is tied to the game version (any new state clears it). Take/Pass buttons appear only when legal; spectators get no hand and no buttons.
- **Countdown:** `remainingMs = turnDeadline − serverTime − (now − receivedAt)` using the client's clock for both `receivedAt` and `now`, so clock skew between client and server doesn't matter.
- **Strings:** every UI string and every error code's Hebrew message live in `src/i18n/he.ts` (typed `Strings`; `errors` must cover every `ServerErrorCode | GameErrorCode`). Cards are drawn with CSS (rank + suit symbol), no image assets.
- **Env:** `VITE_SERVER_URL` (build time) overrides the server URL. Otherwise a production build connects to its own origin (the server hosts the client), and dev mode to `http://localhost:3000` (`serverUrl()` in `net/transport.ts`). Vite runs on 5173 (`strictPort`), matching the server's default `CORS_ORIGINS`.
- **Refused handshakes:** a server middleware refusal (`connect_error` with a code such as `TOO_MANY_CONNECTIONS`) is surfaced as an `error` event and retried after 15 s, because socket.io doesn't retry those itself.

## Bot (`packages/game-engine/src/bot`, Phase 4a)
A pure library: no server or UI wiring (that is 4b). Exported from `@durak/game-engine`.

**No-cheating rule (NEVER VIOLATE):** the bot only gets what a human player gets.
- The public API is `chooseBotMove(view: PlayerView, knowledge: PublicKnowledge, options) -> ClientMove | null` (`null` = no legal move), plus `Bot.choose(view, knowledge, rng)` for `RandomBot`, `GreedyBot` and `createIsmctsBot`. None of them ever receives a `GameState`.
- A `GameState` exists in the bot only as a *determinization*: a world sampled from the view and the knowledge (`determinize.ts`, the only file that assembles one), then simulated.
- `tests/bot/noCheating.test.ts` enforces this by checking imports:
  - View-only files (`knowledge`, `greedy`, `baselines`, `moveKey`, and the barrel `index`) may import only `@durak/shared`, `viewMoves`, `viewInference`, `rng`, `deck`, `result` and other view-only files.
  - Simulation files (`determinize`, `ismcts`, `turnOrder`, `rewards`) may also import `state` and `rules`.
  - No bot file may call `sanitizeStateForPlayer` or `createGame*`.
  - A type test pins the `chooseBotMove` signature.
  - A new bot file must be classified in that test.

**`PublicKnowledge` (`knowledge.ts`)** is plain JSON, so it can be persisted. It is built by `initKnowledge(view)` and advanced with `updateKnowledge(k, prevView, nextView)` on every view the player receives. It only records facts it can prove; property tests check it against the real state on every step for every seat.
- `discard`: cards proven to be in the discard pile. Beaten `lastBout` cards are added at each resolution, and cards never leave the discard.
- `knownHands[opponent]`:
  - Table cards the opponent picked up with a take are added. They are removed from every other opponent's known hand.
  - When the stock runs out, the face-up trump goes to the last drawer. This is added only if every closer scenario from `inferBoutResolution` agrees on who that is.
  - With 6 players the trump starts in seat 5's hand during bout 1.
  - A card disappears from a known hand as soon as it is visible on the table, in my hand or in the discard.
  - Finished players know nothing.
- Missed steps (a bout jump, a different viewer, or any inconsistency) keep the discard and restart hand knowledge from the current view.
- Not inferred (future refinements): suit voids from strategic takes, and the bout-1 "first attacker holds the lowest trump" constraint.
- `unseenCards(k, view)` = everything not in my hand, on the table, in `discard`, in a known hand, or (while the stock lasts) the face-up trump.

**Determinization (`sampleWorld`)**:
1. Shuffle the unseen cards.
2. Deal them in a fixed order: each opponent in seat order gets their known cards plus enough unseen cards to match their hand count; then the stock gets `deckCount - 1` cards with the trump last; then the unidentified part of the discard.
3. Everything else is copied from the view.

Every sampled world passes the fuzz invariants and re-sanitizes to exactly the bot's view (property test). If the knowledge doesn't fit the view, the bot falls back to `initKnowledge(view)`.

**Search (`ismcts.ts`): Single-Observer IS-MCTS** (Cowling, Powley & Whitehouse 2012). Every Durak move is public; only card locations are hidden. The tree is built over the bot's information sets, with a fresh determinization each iteration.
- Children are keyed by `actorSeat|moveKey`. UCB1 uses availability counts: `mean + c*sqrt(ln(availability)/visits)`, with `c = 0.7`. The final move is the root child with the most visits. Draws are absorbed by the determinization; there are no chance nodes.
- **Canonical player to move** (`turnOrder.ts`, `canonicalActor`):
  - `awaitingAttack` → the main attacker.
  - A card is uncovered and the defender isn't taking → the defender.
  - Otherwise → the first non-defender clockwise from the main attacker who is still in, hasn't passed and can throw in.

  So attackers throw in after seeing the defense. The **root** is always the bot itself, even when it is "out of order" (an attacker throwing in while the defender still thinks). The benchmark harness uses the same order.
- **Rewards** (`rewards.ts`) are a per-seat vector in [0, 1], and each node maximizes the reward of the player who moved into it.
  - At the end of the game, the durak gets 0 and everyone else 1. In a draw, the players who went out together get 0.5 and earlier finishers keep 1.
  - At the rollout-depth cutoff (default 200 plies), finished players get 1. Each active player gets `1 - badness/sum(badness)`, where badness is the hand weighted by card weakness.
- **Rollout policy = `GreedyBot`** (`greedy.ts`, `pickGreedy` over the legal moves):
  - Defender: the cheapest defense if every uncovered card can be beaten, otherwise take. It never transfers.
  - Opening: the cheapest card. Cost is the rank for a non-trump and 100 + rank for a trump.
  - Throw-in: the cheapest non-trump, otherwise pass.
- **Budget:** `{ iterations }` (deterministic) or `{ deadlineMs, now }`, where `now` is an injected clock and the deadline is absolute. The engine never reads a clock. A seeded `Rng` (`options.seed`) makes every search reproducible. A single legal move is returned without searching. `searchBotMove` returns diagnostics: iterations and root statistics.

**Benchmark** (`packages/game-engine/bench`, not part of the unit tests; run with `tsx`):
- `npm run bench --workspace=packages/game-engine`: the quick run. It plays 100 games per config over {2,3,4} players × {podkidnoy, perevodnoy} × {Random, Greedy}, on worker threads.
- `-- --full`: the same matrix with 500 games per config.
- `-- --realtime`: 2 players vs Greedy, both modes, 500 games each, at a real 300 ms deadline, on 1 worker by default.
- Options: `--games N`, `--workers N`, `--ms N`.
- Filters (comma-separated lists): `--players 2,3`, `--opponents random,greedy`, `--modes podkidnoy,perevodnoy`.

**Resumable runs:**
- Every finished game is appended to a JSON-lines results file, together with the calibration. The default file is `bench/results/<iterations|realtime>-<ms>ms.jsonl`; it is gitignored, and `--out FILE` overrides it.
- A rerun reuses the stored calibration and skips the games already in the file, so an interrupted run loses only the games that were in flight. A cut-off last line is ignored.
- Quick and `--full` runs share a file (same seeds and budget), so `--full` after a quick run only plays the extra games.
- `--fresh` discards the file and starts over. Use it after changing the bot, since stored outcomes would be stale.

How a run works:
- Every run starts by calibrating how many iterations take about 300 ms on this machine. The quick and full runs then use that fixed iteration count, so their results are reproducible.
- One IS-MCTS seat plays against n−1 copies of the opponent. The IS-MCTS seat rotates over every seat, and the seeds are fixed.
- The harness (`bench/match.ts`, also used by the tests) gives each seat only its view and its own `PublicKnowledge`, and validates every move against the real state.
- The report shows durak rates with Wilson 95% CIs, draws and abandoned games (capped at 3000 moves), iterations/s and ms per move, plus a PASS/FAIL line for the 2-player target: IS-MCTS's CI must lie entirely below Greedy's.

## Production (Phase 6 prep)
**Image** (`Dockerfile`, node:24-alpine, multi-stage):
- The build stage builds shared → game-engine → server → web.
- The runtime stage has only the server's production dependencies, with the workspace symlinks (`node_modules/@durak/*` → `packages/*`, so bot workers load `packages/game-engine/dist`), plus the four `dist` folders.
- It runs as `node`, with `PORT=8080`, a `HEALTHCHECK` on `/health`, and `CMD node apps/server/dist/index.js`.

**One process serves everything** on one origin: Socket.io, `/health` and the web client (`http/webApp.ts`, `@fastify/static`).
- `WEB_DIST_DIR`, or auto-detected `apps/web/dist`. The client isn't served when it isn't built.
- `/assets/*` are immutable-cached; `index.html` is `no-cache`.
- Every other GET falls back to `index.html`, except `/health`, `/socket.io`, missing assets and non-GET requests (JSON 404).

**Config** (`config.ts`; the effective values are logged at startup as `settings`):
- `NODE_ENV=production` makes `CORS_ORIGINS` default to none (same-origin only). Otherwise it is `http://localhost:5173`. `*` is refused.
- The handshake's `allowRequest` accepts: no Origin, the server's own host, or a listed origin.
- `TRUST_PROXY`: `false` | `true` | a hop count (1 behind Fly/Render/Railway). It is used by Fastify and by `clientIp()` (`transport/clientAddress.ts`). X-Forwarded-For is ignored unless trusted.

**Abuse limits** (`transport/rateLimit.ts`, in-process, `DEFAULT_LIMITS`, env in parentheses):
- Per-socket token bucket on every incoming event: burst 20 (`RATE_LIMIT_BURST`), 10/s (`RATE_LIMIT_PER_SEC`). A dropped event never reaches a handler. The client gets at most one `RATE_LIMITED` per second. 100 drops within 10 s (`RATE_LIMIT_DISCONNECT_AFTER`) disconnects the socket.
- Rooms per IP per rolling hour: 30 (`MAX_ROOMS_PER_IP_PER_HOUR`), charged only on success → `TOO_MANY_ROOMS`.
- Stored rooms: 500 (`MAX_ROOMS`), checked in `RoomService.createRoom` by counting `scanIds()` → `SERVER_FULL`. It is a soft cap.
- Sockets per IP: 20 (`MAX_SOCKETS_PER_IP`). The handshake is refused with `connect_error` `TOO_MANY_CONNECTIONS`.
- `buildServer({ limits })`. The socket test harness passes `UNLIMITED`, because tests send many events without advancing the fake clock; limit tests pass their own values.

**No internals to clients:**
- HTTP 5xx bodies are `{"error":"Internal Server Error"}`.
- Socket handler exceptions become `INTERNAL`.
- `unhandledRejection` is logged. `uncaughtException` logs and shuts down (exit 1).
- Shutdown is capped at 10 s.

**Running and deploying:**
- `npm run prod:up` / `prod:down` run `docker-compose.prod.yml` (project `durak-prod`, http://localhost:8080).
- `npm run tunnel` (`scripts/tunnel.mjs`): the prod stack behind a Cloudflare Quick Tunnel; prints the public `https://*.trycloudflare.com` URL; Ctrl+C stops the tunnel only (`prod:down` stops the stack). It sets `TRUST_PROXY=1` and `APP_BIND=127.0.0.1` (the compose port binding). Verified on a real tunnel: Cloudflare's edge appends the client to `X-Forwarded-For`, cloudflared adds nothing, and the Host header is preserved (the Origin check passes as same-origin). Trusting exactly 1 hop yields the real client; without it every player is Docker's gateway. Each socket logs `socket connected { ip, transport }`.
- `npm run smoke -- <url>` (`scripts/smoke.mjs`, needs a built engine) checks `/health`, the SPA fallback and its assets, then plays a real game against a medium bot over a same-origin socket.
- Deploy: `DEPLOY.md` (Hebrew) and `fly.toml`: one always-on machine, `fly deploy --ha=false`. **Single instance only** (see above).

**CI** (`.github/workflows/ci.yml`):
- A typecheck → build → `npm test` job, with a Redis service.
- A docker job: builds the image, boots it with Redis and runs the smoke test.

## Development Workflow & Commands
- Build all workspaces: `npm run build --workspaces`
- Run every test: `npm test`. `scripts/run-tests.mjs` runs the workspaces in sequence with a hard per-workspace limit (`TEST_WORKSPACE_TIMEOUT_MS`, default 10 min): on expiry it kills the process tree and fails, naming the workspace. A test run must never hang. game-engine uses half the cores (`maxWorkers`) so its CPU-heavy tests can't starve Vitest's main process. Always wrap long verification commands in a timeout.
- Run engine tests: `npm test --workspace=packages/game-engine` (includes the bot tests in `tests/bot/`)
- Run the bot benchmark: `npm run bench --workspace=packages/game-engine` (`-- --full`, `-- --realtime`; see "Bot" above)
- Run server tests: `npm test --workspace=apps/server` (Redis tests need `docker-compose up -d` or any Redis at `REDIS_URL`; without one they are skipped with a warning)
- Run server + web together: `npm run dev` (builds `shared` + `game-engine` for the server's `tsx`, then runs both with `concurrently`; open http://localhost:5173)
- Run the server in dev mode: `npm run dev --workspace=apps/server` (env: `PORT`, `HOST`, `CORS_ORIGINS`, `TRUST_PROXY`, `BOT_WORKERS`, `BOT_JOB_TIMEOUT_MS`, the limits above, `WEB_DIST_DIR`; see `.env.example`; bot workers need a built `game-engine`)
- Run the web client alone: `npm run dev --workspace=apps/web`; tests: `npm test --workspace=apps/web` (Vitest + jsdom + Testing Library; `tests/sessions.test.ts` starts a real in-process server)
- Start local infrastructure: `docker-compose up -d`
- Production build locally: `npm run prod:up` → http://localhost:8080; end-to-end check: `npm run smoke -- http://localhost:8080`

## Implementation Roadmap (Execute Step-by-Step)
- **Phase 1: Foundation & Shared Contracts.** Initialize monorepo, `tsconfig.base.json`, `docker-compose.yml` (Redis + Postgres), and `packages/shared` types + Zod event schemas.
- **Phase 2: Pure Durak Engine & Test Suite.** Build `packages/game-engine` (deck, attack/defense/throw-in validation, draw order, tie-breakers, state sanitizer). Write comprehensive Vitest unit tests covering all edge cases before writing any server code.
- **Phase 3: Real-Time Server & Persistence.** Build `apps/server` with Fastify + Socket.io, Redis room repository, session reconnection logic, and PostgreSQL match persistence. Every `game:move` carries a required `expectedVersion`; reject moves against a stale version.
  - **Turn timers & AFK** (implemented in 3c, `services/TurnTimerService.ts`):
    - Server owns turn timers. On timeout: defender -> take, non-defender who can throw in -> pass. Engine stays timer-free.
    - Opening attacker timeout: the server auto-plays the attacker's lowest non-trump card (lowest rank; ties broken by suit order S, C, D, H), or the lowest trump if they hold only trumps.
    - If every card is covered, the defender has no pending action (`take` is illegal), so no defender timer runs; the bout only waits on non-defenders.
    - After 2 consecutive timeouts the player is marked AFK and the bot (medium) plays on their behalf until they move or resume (Phase 4b, see "Bots in games"). If the reconnection grace window expires, the player forfeits.
    - Every auto-move (timeout or bot) goes through the same `validateMove` / `applyMove` path as a human move.
    - **Settings (env):** `TURN_TIMEOUT_MS` (30000), `AFK_TIMEOUT_MS` (5000, used when *every* awaited player is AFK), `RECONNECT_GRACE_MS` (60000).
    - **Data model:** `StoredGame.turnDeadline` (epoch ms or null), `timeoutStreak`, `endReason` (`'normal' | 'forfeit' | 'abandoned'`). `RoomMember.afk` (public, in `room:state`), plus server-only `consecutiveTimeouts` and `graceDeadline`. `game:state` carries `turnDeadline` and `serverTime`, so clients show a countdown free of clock skew; `game:over` carries `endReason`. Deadlines are persisted, so they survive restarts. The new codec fields have Zod defaults, so 3b records still decode.
    - **Turn timer** (one per game): armed on start and after every successful change (human move, timeout, or a resume that extends the deadline). On expiry, inside the room lock: a version mismatch → no-op (stale); woken early → re-arm; otherwise apply the timeout step, `version + 1`, save room + game atomically, broadcast, arm the next deadline. Finished or forfeited → cleared.
    - **AFK:** `consecutiveTimeouts` is incremented for each player whose timeout move was applied; at 2 → `afk = true`. A human move or `session:resume` resets both. A resume by an awaited player extends a short AFK deadline to a full turn.
    - **Abandon guard:** `StoredGame.timeoutStreak` counts consecutive expiries with no human move in between (any human move resets it). When it reaches `3 × players still in` (`services/timeoutPolicy.ts`), the game is abandoned: `durak = null`, `endReason = 'abandoned'`. Abandoned games must be excluded from ELO (3d). A real draw is `durak = null` with `endReason = 'normal'`.
    - **Reconnection grace:** a seated player who is still in, in a `playing` room, whose last socket disconnects gets `graceDeadline = now + RECONNECT_GRACE_MS`. Resume cancels it. On expiry (still offline, same deadline) → `resign` → `endReason = 'forfeit'`, durak = the leaver. No grace in the lobby, after the game, or for a player who is already out. Disconnects caused by server shutdown never start a grace.
    - **Startup order:** ghost reset (everyone offline) → `buildServer` → `timers.rearmAll()` (re-arms every persisted deadline; past ones fire immediately; offline players without a grace get one) → `listen`.
    - **Testing:** `Clock` and `Scheduler` are injected (`services/scheduling.ts`). Tests use `tests/helpers/fakeTime.ts` (`advanceBy` / `runDue`), never real sleeps.
- **Phase 4: IS-MCTS AI Bot.** Implement determinized Monte Carlo Tree Search in `packages/game-engine/src/bot` with a configurable thinking time budget (e.g., 300ms per move) and benchmark win rates against a random baseline bot.
  - **4a (done):** the pure bot library: `PublicKnowledge`, determinization, SO-ISMCTS, Random/Greedy baselines, benchmark. See "Bot" above.
  - **4b (done):** server and web integration: bot seats, the worker pool, BotDriver, persisted knowledge, AFK takeover, and "play vs computer". See "Bots in games".
- **Phase 5: Mobile-First Web Client.** Build `apps/web` with clean card animations, responsive table layout for 2-6 players, and room invite links.
  - **5a (done):** playable client: home, invite links, lobby, table with legal-move highlighting, countdown, game over + rematch, spectators. See "Web Client" above.
  - **5b:** animations and visual polish.
- **Phase 6: Deployment.**
  - **Prep (done):** production image, same-origin serving, prod compose, hardening (rate/abuse limits, proxy trust, CORS), CI, `DEPLOY.md`. See "Production".
  - **Next:** deploy to Fly.io (manual, see `DEPLOY.md`).

## Coding Conventions
- Prefer explicit union types and discriminated unions for game phases and move actions.
- Handle errors explicitly via Result objects or custom domain error classes rather than silent failures.
- Every bug fix in `packages/game-engine` must include a regression test in `packages/game-engine/tests/`.