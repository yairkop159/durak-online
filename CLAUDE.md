# Project: Durak Online (Multiplayer Card Game Engine + IS-MCTS AI)

## Overview
A real-time, server-authoritative multiplayer web implementation of the Russian card game **Durak** (36-card deck, supporting 2-6 players, classic "Podkidnoy" rules with optional "Perevodnoy" passing mode) featuring an Information Set Monte Carlo Tree Search (IS-MCTS) AI bot.

## Tech Stack & Monorepo Architecture
- **Language:** Strict TypeScript across all workspaces (`strict: true`, no `any`).
- **Monorepo:** `npm workspaces` (`packages/shared`, `packages/game-engine`, `apps/server`, `apps/web`).
- **Backend:** Node.js, Fastify, Socket.io, Zod (payload validation).
- **Databases:** Redis (active game state & session tokens with TTL), PostgreSQL + Prisma 7 (device profiles, completed match history & ELO ratings; optional at runtime, see "Profiles, history and ratings").
- **Frontend:** React 19, Vite, Tailwind CSS, Framer Motion (mobile-first responsive UI).
- **Testing:** Vitest (unit & state-machine edge-case testing).
- **Infrastructure:** Docker Compose for local Redis and PostgreSQL (`docker-compose.yml`); one production image (`Dockerfile`) and `docker-compose.prod.yml` (app + Redis + Postgres). See "Production" below.

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
- **Legal moves from a view:** `getLegalMovesForView(view)` (`src/viewMoves.ts`) computes the viewer's legal moves from the sanitized `PlayerView` alone (used by the web client and test bots). It must equal `getLegalMoves(state, p)` without `playerId`, for every player and every reachable state; the fuzz harness (`tests/selfPlay.ts`, run by `tests/fuzz.*.test.ts`) checks this on every step. Any rule change must update both.
- **Timeouts & resignation** (`src/timeout.ts`, pure; the engine has no timers):
  - `getTimeoutMoves(state)`: `awaitingAttack` → the attacker opens with the lowest non-trump (lowest rank, ties S, C, D, H), or the lowest trump if they hold only trumps. `bout` → the defender `take`s if a card is uncovered and they aren't already taking, then every non-defender who can still throw in and hasn't passed `pass`es, in seat order from the main attacker. `getAwaitedPlayers` = the players those moves belong to.
  - `applyTimeout(state)` applies them in order, each through `applyMove`, skipping any that an earlier one made obsolete. Each call opens a bout or ends the current one (it is never a no-op).
  - **Known limitation:** timeouts alone can cycle forever. Each take leaves the taker above 6 cards, so nobody draws (even with cards still in the stock), nothing is discarded, and one card circulates around the table. A regression test pins this down; the server's abandon guard handles it.
  - `resign(state, playerId)` → finished, durak = that player. `abandon(state)` → finished, durak = `null`. Both append everyone still in to `finishOrder` and leave the cards untouched.

## Server Architecture (`apps/server`)
Layers, one folder each; dependencies point downward only:
- **`transport/`**: Socket.io handlers. Every incoming event is parsed with its schema from `ClientEventSchemas` before anything else; an invalid payload or unknown event gets an `error` event (`INVALID_PAYLOAD`) and never throws. Every handler is wrapped so an unexpected exception becomes `error {INTERNAL}`. **Logging** (info level, JSON): `socket connected {ip, transport}`, `socket disconnected {reason, roomId, playerId, role, ip}`, `session resumed` / `session resume failed {code}`, `error sent to client {code, event?}` (every error emitted to a client goes through `sendError`), and `connection refused` / `handshake refused: origin not allowed`. Log lines never include session tokens or payloads (`tests/socket.logging.test.ts`). `SocketNotifier` builds every `game:state` per recipient through `sanitizeStateForPlayer` (spectators get the `null` view); there is never one shared payload. Socket.io limits: `maxHttpBufferSize` 16 KB, CORS from `CORS_ORIGINS`, an Origin check on the handshake, and the abuse limits in "Production" (rate limiting runs in `socket.use`, before validation).
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
- **Rematch (`room:rematch`):** any seated player of a `finished` room puts it back to `lobby` (same members except seats marked `leftGame`, which are freed; `afk`/`consecutiveTimeouts`/`graceDeadline` reset; offline members keep their seat and can resume) and the finished game is deleted, atomically via `repos.atomic.saveRoomDeleteGame`. In the lobby it is a no-op that re-sends `room:state` (idempotent: everyone may press "back to lobby"); while playing → `GAME_IN_PROGRESS`; spectators → `NOT_IN_ROOM`.

### Leaving a game (Phase 7)
One rule decides what a departure does: `departureKind` in `packages/shared/src/departure.ts`, applied on the server by `services/departure.ts` (`departureOutcome`, `departSeat`) and shown by the web leave dialog (`apps/web/src/game/departure.ts`).
- `none`: no running game, or the player already went out. Nothing changes in the game.
- `takeover`: 3+ seats and another human (not a bot, not `leftGame`) is still in the game. The seat becomes `isBot: true, botDifficulty: 'medium', leftGame: true` (same `playerId` and nickname), and the game goes on. The version bumps once with the state unchanged, so clients get the new seat and the BotDriver plans for it.
- `resign`: everything else, so a 2-player game always ends. `resign` → `endReason: 'forfeit'`, durak = the leaver.
- Both a voluntary `room:leave` and a reconnection-grace expiry use it. A leave also deletes the session, unbinds every socket holding it, moves the host to the first active human, and marks the seat `leftGame` (on `resign` and `none` too). A grace-expiry `resign` leaves the seat as it was, so the player can resume into the game-over screen.
- Data:
  - `RoomMember.leftGame` is public. The codec defaults it to `false`.
  - `StoredGame.forfeits: PlayerId[]` holds every human who left or timed out. The codec defaults it to `[]`, and it is sent in `game:over`.
  - A takeover also adds the leaver to `botAssisted`.
- `session:resume` for a seat that is now `isBot`/`leftGame` deletes the session and returns `INVALID_SESSION`.
- **Rating semantics (Phase 10):** every id in `forfeits` is a loss, `durakId` is a loss, and `endReason` `abandoned`/`restarted` games are not rated.

### Restart vote (Phase 7)
`services/RestartVoteService.ts` runs the vote; the pure rules are in `services/restartVote.ts`. Every mutation happens inside the room lock, and the timer runs on the injected `Scheduler`.
- **Events** (Zod, shared):
  - `room:restartPropose { roomId }`
  - `room:restartRespond { roomId, voteId, accept }`
  - the server sends `room:restartVoteEnded { roomId, voteId, proposerId, outcome: passed|declined|expired|cancelled, by }`.
  - The open vote is public in `room:state.restartVote { voteId, proposerId, expiresAt, serverTime, accepted, awaiting }`, so a resume hydrates it.
  - Errors: `VOTE_IN_PROGRESS`, `VOTE_COOLDOWN`, `NO_ACTIVE_VOTE`.
- **Persisted** (codec defaults `null` / `{}`):
  - `Room.restartVote { voteId, proposerId, expiresAt, voters, accepted }`
  - `Room.restartCooldowns` (proposer → until).
- **Who:**
  - Any seated human who hasn't left may propose, only while a game runs and no vote is open.
  - Voters are the other members who are human, `connected`, not `afk` and not `leftGame`. Bots and absent humans don't block, so a vote with no voters passes at once.
  - A voter who disconnects or leaves mid-vote is dropped (`RoomService` calls `votes.reconcile`).
  - The proposer leaving cancels the vote, and a game that finishes on its own cancels it (`GameCommitter`).
- **Ending:**
  - A decline → `declined`.
  - `RESTART_VOTE_MS` (30 s) → `expired`.
  - Every non-passed outcome puts the proposer on a `RESTART_COOLDOWN_MS` (60 s) cooldown.
  - Persisted votes are re-armed at startup (`votes.rearmAll()`).
- **Passed:**
  - The old game is reported with `game:over { endReason: 'restarted', durakId: null }` (not rated) but not stored.
  - `dealGame` (`services/dealing.ts`, shared with `game:start`) deals a new game with the same seats and config and a fresh seed. `GameCommitter.start` saves it at version 0.
  - `StoredGame.gameId` / `GameStatePayload.gameId` identify a game. The web reducer replaces its game when the id changes, and the BotDriver keys its plans by `(gameId, version)`.

### Quick reactions (Phase 8)
A fixed list, no free text: `REACTION_IDS` in `packages/shared/src/reactions.ts` (`laugh 😂, fire 🔥, shock 😱, clap 👏, think 🤔, nice "יפה!", lucky "מזל...", ohNo "אוי לא", again "עוד סיבוב?"`; the glyphs/phrases live in `he.ts`).
- **Events:** `room:react { roomId, reactionId }` (Zod enum) → the server broadcasts `room:reaction { roomId, playerId, reactionId }` to the whole room, spectators included.
- **Who:** a seated member of that room who is not `leftGame` and not a bot seat; otherwise `NOT_IN_ROOM`. Works in the lobby, while playing and after the game.
- **Limit:** per player, a token bucket (burst `REACTION_BURST` 3, one per `REACTION_REFILL_MS` 2 s), on top of the per-socket limiter. Over the limit the reaction is **dropped silently** (no error, no broadcast); the web client mirrors the bucket (`reactions/bucket.ts`) and greys the picker out.
- **Ephemeral:** `services/ReactionService.ts` reads the room once, checks and broadcasts through `RoomNotifier.reaction`. No lock, nothing written to Redis, payloads never logged. Idle buckets are swept.
- **Bot reactions:** `ReactionService` is also a `GameChangeListener` (the committer calls its listeners in order: BotDriver, then ReactionService). On each committed move it diffs the full states with `services/gameEvents.ts` (pure, public events only) and finds each bot seat's own biggest moment: durak (`ohNo`/`shock`) > went out (`clap`/`fire`) > perfect defense, a beaten bout with ≥ `PERFECT_DEFENSE_MIN_PAIRS` (3) pairs (`fire`/`nice`) > transfer (`laugh`/`think`). Chance 0.35 (injectable `random`), per-bot bucket (1 per 15 s), sent 700-1500 ms later on the injected `Scheduler`. Never on start/resume/startup (`prev === null`) or for the bots-only fast-forward (`GameChangeInfo.fastForwarded`). The test harnesses set `botChance: 0` unless a test turns it on.

### End-of-game stats (Phase 8)
`PlayerStats` (`packages/shared/src/stats.ts`): `boutsAttacked` (bouts opened), `boutsDefended`, `defenses` (beaten) + `takes` (= `boutsDefended`), `cardsTaken`, `throwIns`, `transfers`, `cardsPlayed`. Public information only: every count comes from a card that went face-up on the table or from the bout resolution (`services/gameEvents.ts`; the full states are used only to attribute a now-visible card to the hand it left).
- Advanced in the single write path: `GameCommitter.commit` adds `statsDelta(gameEvents(prev.state, state))` (a commit holds at most one bout resolution: a move, or one `applyTimeout`), and the bots-only fast-forward adds each of its moves. `start` sets zeros for every seat.
- Stored in `StoredGame.stats` (codec default `{}`, so older records decode) and sent in `game:over.stats` (the `restarted` one too).
- The web shows highlights (`game/highlights.ts`: most cards taken, best defense with the success rate as tie-break, most transfers in perevodnoy, most throw-ins; only values > 0) and a collapsible per-player table on the game-over overlay; none after a reload (no `game:over`).

### Bots in games (Phase 4b)
**Seats.**
- `RoomMember.isBot: boolean` and `botDifficulty: 'easy' | 'medium' | 'hard' | null`. Both are public in `room:state`.
- Bot seats are built only by `newBotMember`, or by `takeoverMember` when a human leaves a 3+ player game (see "Leaving a game"). They are always `connected`, never AFK, never get a grace period, and have no session or socket. The ghost reset, `rearmAll` graces and `markDisconnected` all skip them.
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

`announce(...)` notifies the listener without a new version (resume, startup). Never write a game version anywhere else. The one write to a `StoredGame` outside the committer is `RatingsPublisher` (see "Rating change on game over"): it adds `ratings` to a finished game with `games.replaceKeepingTtl` (no version bump, no listeners, the remaining TTL kept).

**Data:**
- `StoredGame.knowledge: Record<PlayerId, PublicKnowledge>` covers every seat, humans included, because of the AFK takeover. A missing entry is rebuilt with `initKnowledge`, which is sound.
- `StoredGame.botAssisted: PlayerId[]` lists the humans a bot ever moved for. It is sent in `game:over` and marked in the match history (Phase 10).
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
- **Routes:** `/` (home: nickname, player count, mode → `room:create`), `/rules` (rules + interface guide), `/profile`, `/profile/:id`, `/leaderboard` (Phase 10) and `/room/:id` (join prompt / lobby / table / game-over overlay / room not found). Tiny router in `src/routing.ts` (History API).
- **`src/net/`:** `Transport` (socket.io-client wrapper; tests use `FakeTransport`), `GameClient` (the single connection: feeds server events into the store, owns session tokens, exposes actions), `Store` + pure `reducer` read via `useSyncExternalStore`. Every `game:move` carries `expectedVersion` = the last received `game:state` version. `STALE_STATE` errors are swallowed (the server re-sends the state). A `game:state` older than the held version of the same game (`gameId`) is ignored; a new `gameId` (restart vote) replaces the game. `room:state` with status `lobby` clears the game (rematch).
- **Sessions:** tokens are kept in **`sessionStorage`** (`durak:sessions` = `{ roomId: token }`), NOT `localStorage`, so every tab is its own seat (two windows of one browser = two players). A reload keeps the seat: on every (re)connect, the room in the URL is resumed with `session:resume`. **Every new socket must resume, socket.io's automatic reconnects included:** the server binds sessions per socket, so the store's `bound` flag is cleared on every disconnect and set by `session:issued`. `session:resume` is the first event on a new socket. Moves and other session actions are dropped while `!canAct(state)` (disconnected or resuming), never buffered: socket.io would flush them before the resume, and they would hit `NOT_IN_ROOM`. Regression tests: `tests/reconnect.test.tsx`, and a real-server TCP-relay cut in `tests/sessions.test.ts`. A `NOT_IN_ROOM` while holding a session means the server lost this socket's binding: the client marks itself unbound and resumes, which resends room + game state. No toast is shown, and only one resume runs at a time. While `isReconnecting(state)` (in a room and `!canAct`, or a resume pending), the `ConnectionBanner` shows "מתחבר מחדש...", `<main>` is `inert`, and the table offers no moves. **Trade-off:** closing the tab forgets the token, so that seat is forfeited once `RECONNECT_GRACE_MS` expires. A rejected token (`INVALID_SESSION` / `ROOM_NOT_FOUND`) is deleted and the join prompt (or "room not found") is shown. A connection holds one session, so switching rooms reconnects the socket first.
- **Bots (4b):**
  - The host's lobby (while a seat is free) has a "missing players? add a bot" heading with a short hint, a difficulty picker and "add bot", and bot rows have a remove button.
  - Bot seats show `BotPill` (🤖 + difficulty) and a localized name (`displayName`).
  - An AFK human's seat shows "הבוט משחק במקומך" / "בוט משחק".
  - Home's "play vs computer" takes a difficulty and a number of opponents (1-5, default 1). It is a `GameClient.playVsComputer` intent: `room:create` (opponents + 1 seats) → one `room:addBot` at a time (the next once the previous bot appears in `room:state`) → `game:start` once all are seated. Any error or leaving cancels it, and so does a human filling the last free seat.
- **Table interaction (`src/game/selection.ts`, pure):** legal moves come from `getLegalMovesForView`; legal hand cards are highlighted, others dimmed. Attack/throw-in = one click. Defend = hand card then attack card, or attack card then hand card. Transfer = hand card then the "transfer" slot. Selection is tied to the game version (any new state clears it). Take/Pass buttons appear only when legal; spectators get no hand and no buttons.
- **The table fits one screen (never scrolls):** while `/room/:id` shows the table (`showsTable`), `App` is `h-dvh overflow-hidden`; seats, status, my seat + Take/Pass (one row) and the hand are fixed rows, and the table takes the rest. `TableArea` measures its box and shrinks the table cards to fit (`fitTableCardWidth`: at most `PAIRS_PER_ROW` 3 pairs per row, never above the natural size; the card font follows `--card-table-w`). `HandFan` raises its overlap to fit the width (`fitOverlap`, ≥ 16 px of each card stays visible) instead of scrolling; hand cards are at most 15dvh tall. The browser test's `?scenario=crowded` fixture (6 pairs, 15-card hand, banner + bubble) checks 1280×720, 1366×768, 1920×1080 and 360×740: no document scroll, every hand card and Take inside the viewport and clickable (`SCREENSHOT_DIR=<dir>` saves screenshots).
- **Settings (Phase 7, `src/settings/`):**
  - Per device in `localStorage['durak:settings']`: `{ v: 3, sfx: { enabled, volume }, music: { enabled, volume }, animationSpeed: 'normal'|'fast', showTips, tipsSeen, showReactions, vibration }`. v2 (Phase 8) added `showReactions`, v3 (Phase 9) `vibration`; older data migrates field by field.
  - Defaults: sound on at 0.7, music off, normal speed, tips on, reactions on.
  - Parsed field by field: bad data falls back to the defaults, every storage access is in try/catch, and the store works in memory if storage is blocked.
  - `App` wraps everything in `PrefsProvider` (`settings/react.tsx`: `useSettings`, `useSettingsStore`, `useAudio`); tests can inject `settings` / `audio`.
  - The gear (`SettingsButton`) is on Home and in the table's top bar.
  - `fast` scales every timeline duration by 0.6 (`scheduleEvents({ speed })`); reduced motion still wins.
  - Tests get an in-memory `localStorage` from `tests/setup.ts` (Node's own global hides jsdom's), cleared after each test.
- **Audio (Phase 7, `src/audio/`, Web Audio only, no files):**
  - `AudioEngine` has sfx and music buses. Nothing exists before `unlock()`, called on the first `pointerdown`/`keydown` (autoplay policy). Without an `AudioContext` (jsdom) everything is a no-op.
  - `sfx.ts` synthesizes `cardPlay`, `defend`, `take`, `sweep`, `draw`, `yourTurn`, `tick`, `win`, `durak`.
  - `music.ts` is a quiet generative loop (pad + pentatonic plucks, lookahead scheduler), off by default.
  - `soundPlan.ts` (pure) maps the `diffViews` events on the animation timeline to sounds, plus the turn chime, the last-5-seconds ticks of my own turn, and the win/durak stinger (none for spectators, `abandoned` or `restarted`).
  - `useGameSounds` (TableScreen) plays them. No server messages are involved.
- **Rules, guide and tips (Phase 7):**
  - `screens/rules/RulesContent.tsx` holds the rules and the interface guide in two tabs. The examples are drawn with the real `PlayingCard`/`CardBack` components, and all text lives in `he.ts` (`help`, `tips`).
  - It is shown as the `/rules` page (linked from Home) and as the in-game "?" dialog (`HelpButton`). In a room it must stay a dialog, because navigating away from `/room/:id` drops the room binding.
  - First-game tips: `tips/tips.ts` (pure) has `tipFor(view, moves, tipsSeen)`, giving `firstAttack | firstDefense | firstThrowIn | firstTransfer`. `TipBanner` sits above the hand.
  - A tip is marked seen when it is dismissed or when its move is made (`tipLearnedBy`). Tips are hidden when `showTips` is off, and the settings can reset them.
- **Moments (Phase 8, `src/anim/moments.ts`, pure):** `momentsFor(prev, next, diffViews events)` → `wentOut` (new ids in `finishOrder`) > `deckOut` (the stock emptied; `trumpTo` = the drawer of the face-up trump, or null when the views can't tell) > `bigTake` (≥ 4 cards) > `transfer` > `perfectDefense` (a beaten bout with ≥ 3 pairs). None on the game's last step (the reveal takes over). `BoardAnimation.moments` times each after its animation; `useMomentQueue` shows one banner at a time (`MomentBanner`, ~1.6 s × speed, a queue of 3 dropping the least important, outliving the state that caused it), plays its sound (`MOMENT_SOUNDS`: `wentOut`, `deckOut`, `bigTake`, `transfer`, `perfect`) and gives the seat an effect (`SeatEffect`: celebrate / shake / shine / pulse; a static ring under reduced motion). Banner text: `moments/momentText.ts` + `he.ts`, also in a polite live region.
- **Durak reveal (Phase 8):** `anim/reveal.ts` plans dim (400 ms) → drumroll + a spotlight sweeping the seats to the durak (1200 ms) → the "דוראק!" stamp with the stinger (800 ms), × the animation speed; a forfeit skips the sweep, a draw stamps "תיקו!" in the middle; none for `abandoned`/`restarted`, under reduced motion, or after a reload into a finished game (only a game the client watched end). `DurakReveal` runs before `GameOverOverlay`; `useGameSounds` leaves the stinger to it (`stingerByReveal`).
- **Overlays never block play:** banners, bubbles, seat effects and the reveal's visuals are `pointer-events-none`; the only interactive overlays are the reaction picker (while open) and the reveal's tap-to-skip layer (the game is over then). The real-browser test (`tests/browser/hitTest.test.ts`, fixture `tests/browser/fixtures/table.html`: the real app fed by an in-page fake server) samples a grid over every hand card and Take/Pass while a banner, a seat effect and bubbles are up, checks that an overlay really overlaps a control, and clicks a card and Take with a raw mouse.
- **Quick reactions (Phase 8, `src/reactions/`):** `room:reaction` → the store keeps the recent ones (`ClientState.reactions`, pruned after `REACTION_SHOW_MS` 2.5 s by `useReactions`). `ReactionButton` (💬, a 3×3 picker; Esc / click outside closes and returns focus) sits in my seat row, in the lobby and on the game-over overlay; spectators and left seats get none. `ReactionBubble` floats above the sender's avatar (`pointer-events-none`, scaled by the animation speed, a fade under reduced motion), `ReactionAnnouncer` is a polite live region, and each new reaction plays the soft `reaction` sfx. "Show reactions" off hides bubbles, sound and the button.
- **Phones (Phase 9):**
  - **Layout modes** (`src/layout/layoutMode.ts`, `layoutModeFor(w, h)`): `short` (height ≤ 500 and landscape), `phone` (width ≤ 639), else `regular`. Phone: compact opponent seats (`OpponentSeat variant="compact"`: card count on the avatar, no fan), the deck/discard as a small strip above the table (`DeckPile/DiscardPile small`), natural table cards 72 px. Short (a phone on its side; height is scarce, width is not): three full-height columns. In the RTL row the first child is on the right, where reading starts: "leave" over the opponents stacked as inline seats (`data-testid="seat-column"`). The centre: the table at full width, the hand under it (`HandFan short`: `min(108px, 30dvh, 14vw)` tall). The left: the room tools, the deck + discard (`data-testid="piles"`), the status, my seat and Take/Pass (`side-panel`). No first-game tips (no room). Measured at 844x320 (an iPhone in Safari) with two pairs: table cards 65 px wide (were 51 with seats and piles in rows). `fitTableCardWidth` returns `{ width, columns }`: more than `PAIRS_PER_ROW` per row only when that gives bigger cards.
  - Touch targets ≥ 44 px everywhere (hand cards: a visible slice ≥ 16 px); safe-area insets (`viewport-fit=cover` is required) are read only through `--sai-top/right/bottom/left` (`index.css`, defaulting to `env(safe-area-inset-*)`), never `env()` directly, so tests can simulate a notch; the shell, toasts and overlays (`p-safe-4`) use them, and the table pads its sides and bottom with `max(var(--sai-*), gap)` (in landscape the notch is on the left or right); `touch-action: manipulation` (no double-tap zoom, pinch still works); no text selection/callout except inputs and `[data-selectable]` (the rules text); no overscroll on the table. The game-over actions are sticky at the panel's bottom.
  - **PWA** (`build/pwa.ts`, a local Vite plugin; no binary art in the repo): `manifest.webmanifest` (Hebrew, standalone, colors read from `theme.css` by `build/theme.ts`), icons drawn in code (`build/icons.ts` + the zlib PNG encoder `build/png.ts`: 192/512 any, 512 maskable, 180 apple-touch, 32 favicon), `offline.html` and `sw.js`. Served by the dev server, emitted at `dist`'s root. The service worker answers navigations only (network first, the offline page when offline) and never touches assets, `/socket.io` or `/health`; registered in production builds only (`src/pwa/registerSW.ts`). Needs HTTPS or localhost.
  - **Wake lock** (`src/phone/wakeLock.ts`, `useWakeLock` in `TableScreen`): held while the game runs, re-requested when the page becomes visible, released when it ends.
  - **Vibration** (`src/phone/vibrate.ts`, `useHaptic` from `settings/react.tsx`, injectable `vibrator` on `App`/`PrefsProvider`): "your turn" (with the chime) and the game end (with the stinger / the reveal's stamp). Touch devices with `navigator.vibrate` only (never iPhone); the settings switch shows only there; never for spectators, a hidden page, `abandoned`/`restarted`.
  - **Back from the background** (`src/phone/foreground.ts` → `GameClient.resyncNow(hiddenMs)`): visibilitychange, bfcache `pageshow` and `online`. Disconnected or hidden ≥ `STALE_SOCKET_AFTER_MS` (15 s): `transport.reconnect()` at once (the old socket may be a zombie until the ping timeout); briefly hidden on a live bound socket: `session:resume` on it (a full resync, no banner), one at a time. The server ignores the old socket's late `disconnect` while a newer one is bound (`apps/server/tests/socket.staleSocket.test.ts`).
- **Leave / restart (Phase 7):** the table's `TopBar` holds "leave" (a confirm whose text comes from the shared departure rule), "new game" (the restart vote), "?" and the gear. `RestartVotePanel` shows the open vote, and `NoticeToast` shows how it ended.
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

## Profiles, history and ratings (Phase 10)
Postgres + Prisma hold device profiles, the match history and ELO ratings. **Postgres is optional at runtime:** with `DATABASE_URL` unset, or Postgres down, games run exactly as before; only the profile/rating features answer "unavailable". Nothing on the game path ever awaits Postgres.

**Prisma 7.10.1, pinned exactly** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`, plus `pg` 8.23.1). npm's `latest` tag for `prisma` was an 8.0 RC while `@prisma/client` was 7.10.1, so never `npm i prisma@latest`.
- Prisma 7 setup:
  - the `prisma-client` generator (ESM, `.js` imports) writes to `apps/server/src/generated/prisma` (gitignored). The server's `build`, `typecheck`, `test` and `dev` scripts run `prisma generate` first.
  - `apps/server/prisma.config.ts` holds the URL (Prisma 7 reads neither `url` from the schema nor `.env`).
  - The client connects through the pg driver adapter (no Rust query engine). The CLI's schema engine is fetched by `@prisma/engines`' postinstall (linux-musl in the image).
- Schema: `apps/server/prisma/schema.prisma`. Migrations: `apps/server/prisma/migrations/`. A new migration: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` into a new folder (or `migrate dev --create-only` against a dev database).
- `?schema=name` in `DATABASE_URL` selects a Postgres schema. Tests use one per suite. The pg adapter's `schema` option only qualifies generated queries, so `createPrismaClient` also sets `search_path` (raw SQL relies on it).

**Lifecycle (`src/db/database.ts`):**
- States `disabled` (no URL) | `down` | `ok`.
- After `listen`, in the background: `prisma migrate deploy` (`DB_MIGRATE_ON_START`, default true; `src/db/migrate.ts` spawns the CLI), then a first query. On failure: one warning (password redacted), then a retry every 15 s.
- `/health` adds `postgres: 'ok'|'down'|'disabled'` but **only Redis decides the 503**.
- `onReady` (first start or a later retry) kicks the result queue and re-submits finished games.
- Shutdown: sockets → HTTP → result queue flush (≤ 3 s) → Postgres → Redis.

**Tables:**
- `profiles`: `id`, `nickname`, `device_key_hash` (unique), `transfer_code_hash`/`transfer_expires_at`, `rating` (1000), and the counters `games`, `rated_games`, `wins`, `duraks`, `forfeits`.
- `games`: `id` = gameId, `room_id`, `mode`, `player_count`, `end_reason`, `rated`, `bot_assisted`, `durak_profile_id`, `started_at`, `ended_at`.
- `game_players`: `(game_id, seat)`, `profile_id` (null for bots and unprofiled humans), `nickname`, `is_bot`, `result` (`win|durak|draw|forfeit|unfinished`), `rating_before/after` (null when unrated), `forfeited`, `bot_assisted`.
- A game is stored only if at least one profiled human played.

**Identity (no email, no password, no personal data):**
- A profile is a public random `profileId` (16 bytes base64url) plus a secret **device key** (32 bytes). Only the key's SHA-256 is stored.
- The web keeps `{ v: 1, profileId, deviceKey, nickname }` in `localStorage['durak:profile']`. It goes in localStorage, unlike session tokens, because it is the person, shared by tabs.
- **Transfer = move:**
  - `POST /api/profile/transfer-code` issues an 8-symbol Crockford base32 code (`normalizeTransferCode`: case, dashes, O→0, I/L→1). It is valid 10 minutes, single use, stored hashed, and a new one replaces it.
  - `POST /api/profile/claim` swaps in a new device key in one conditional `UPDATE`, so the old device's key stops working.
- **Seats:**
  - `room:create` / `room:join` take an optional `deviceKey`. It is resolved before the room lock and bounded to 500 ms (`profileLookupMs`). An unknown key, or a slow or dead store → an unprofiled seat, never an error.
  - `RoomMember.profileId` is server-only (never in `room:state`).
  - **One profile, one seat per room:** a second seat with the same profile (two tabs) is seated unprofiled.
  - `dealGame` snapshots `StoredGame.profiles` (playerId → profileId, humans only). The history uses this snapshot. Codec defaults `null` / `{}`.

**HTTP API** (`src/http/api.ts`, under `/api`, in `SERVER_PATHS`, so never the SPA):
- Every body and param is parsed with the shared Zod schemas (`packages/shared/src/profile.ts`). Errors are `{ error: ApiErrorCode }`, with 503 `RATINGS_UNAVAILABLE` while Postgres is down.
- The key travels only as `Authorization: Bearer`. Keys, codes and driver messages are never logged; logs carry only `errorName` and gameIds.
- Endpoints:
  - `POST /profile`
  - `GET` and `PATCH /profile/me`
  - `POST /profile/transfer-code`
  - `POST /profile/claim`
  - `GET /profile/:id`: public; stats, `rank` (leaderboard order, null before a rated game) and the last 20 games.
  - `GET /leaderboard`: top 20 by rating, ties by id, only profiles with ≥ 1 rated game.
- Per client IP (`buildServer({ apiLimits })`): 120 requests per minute, 20 profiles per hour, 10 claims per 10 minutes (every guess counts).
- CORS: listed `CORS_ORIGINS` only.

**Ratings** (pure: `src/ratings/elo.ts` and `gameResult.ts`):
- Per seat: `forfeit` if in `forfeits` (even if also the durak), else `durak`, else `unfinished` (abandoned/restarted), else `draw` (no durak), else `win`.
- Rated iff `endReason` is `normal`/`forfeit` and **≥ 2 profiled humans** played. Bots are never rated. Unprofiled humans are stored without a rating.
- ELO: start 1000, K = 32. Losers are the durak and the forfeiters. Every (loser, non-loser) pair of rated humans is one match, using **K/(n−1)** for n rated humans and the expected scores from the pre-game ratings. Each player's sum is rounded once. Loser–loser and winner–winner pairs are not matched.
  - With no human loser (a draw, or a bot was the durak) everyone gets 0, but the game is still rated.
  - `eloDeltas` throws if a profile appears twice.
- A seat a bot took over (AFK or leave) stays that human's, rated, with `bot_assisted` set.

**Write path:**
- `GameResultRecorder` is a `GameChangeListener` (after BotDriver and ReactionService). On the version that turns a game finished (a move, a timeout/abandon, a forfeit, the bots-only fast-forward), it builds `buildResultInput` synchronously inside the lock and enqueues it. A passed restart vote bypasses `commit`, so `RestartVoteService.onRestarted` reports it (stored as `restarted`, unrated). Announcements (`prev === null`) never record.
- `PrismaResultStore.recordGame` runs as **one interactive transaction**:
  1. Lock the participants' profiles: `SELECT … ORDER BY id FOR UPDATE`.
  2. Insert the game `ON CONFLICT DO NOTHING` on its id. If 0 rows were inserted, return `duplicate` and write nothing else. This makes the write idempotent by gameId, so retries never rate twice.
  3. Insert every seat.
  4. Update ratings and counters.
  
  A profile that no longer exists is stored as an unprofiled seat.
- `ResultQueue`: one write at a time, at most 1000 pending. Outage errors are retried with backoff (2 s doubling to a 5-minute cap) for up to 1 h. Other errors are dropped after 3 attempts, so they never block the queue.
- **Known limit:** the queue lives in memory, and a finished game stays in Redis only 30 min (rematch deletes it sooner). Re-submission on startup or when Postgres comes back covers a crash or a short outage, but a long Postgres outage plus a server restart can lose those results. A re-submitted game gets the re-submission time as `ended_at`. `tests/results.recorder.test.ts` pins this.

**Rating change on game over (`game:ratings`):** the ELO write commits after `game:over`, so the change is sent separately.
- **Event** (Zod `GameRatingsPayloadSchema`, `packages/shared/src/ratings.ts`): `{ roomId, gameId, status: 'pending' }` | `{ …, status: 'unrated', reason: 'notEnoughProfiles' | 'notFinished' }` | `{ …, status: 'rated', entries: [{ playerId, before, after, delta }] }`.
- **When:**
  - Right after `game:over`, `GameResultRecorder` sends `pending` or `unrated` (`ratings/ratingStatus.ts`, pure). It sends nothing while ratings are off or the database client isn't ready, and nothing for a restarted game.
  - `rated` is sent only after a write this process committed and rated. `PrismaResultStore.recordGame` returns `{ kind: 'recorded', ratings }` | `{ kind: 'duplicate' }`, and `ResultQueue.onRecorded` fires only on `recorded` with ratings, without blocking the drain. A duplicate, an unrated game or a failed attempt announces nothing.
  - `RatingsPublisher`, in the room lock: if the finished game with that `gameId` is still stored and not yet annotated, it sets `StoredGame.ratings` (codec default `null`) with `replaceKeepingTtl` (Redis `SET … XX KEEPTTL`), then broadcasts to the room. After a rematch, restart or expiry it is dropped.
  - On `session:resume` and when a spectator joins a finished game, `RoomService` re-sends the current status after the finished `game:state`, so a reload keeps the delta.
- **Accepted gaps:**
  - Postgres dies after the game ended while the client still exists: the status stays `pending`.
  - A crash between the commit and the Redis save: a re-submission is a `duplicate`, so the status stays `pending`.
  - A profile deleted mid-game can turn a `pending` game unrated.
  - In all three cases the client just stops showing "calculating" after 4 s.
- **Web:**
  - `ClientState.ratings` is kept only for the finished game being shown (same room and `gameId`), cleared with it. A later `pending` never replaces `rated`.
  - `RatingResult` shows my change big (`+12` `text-gain` / `−8` `text-loss`, LTR, real minus) with "דירוג חדש: N", "מחשב דירוג..." for at most `RATING_PENDING_SHOW_MS` (4 s), or the unrated reason; nothing without a status.
  - The others' changes are the stats table's rating column, or a list when there is no table (after a reload).
- **Tests:** `apps/server/tests/ratings.event.test.ts` (including the TTL / version / no-listener test on memory and Redis), `socket.ratings.postgres.test.ts`, `socket.outage.test.ts`, `apps/web/tests/ratings.test.tsx`, and the `gameover` / `gameover-reload` audits in `mobile.test.ts`.

**Client IPs** (`transport/clientAddress.ts`; one rule for sockets, `/api` and Fastify):
- Evidence: with only a hop count, any peer that can reach the port can forge `X-Forwarded-For`.
- `TRUSTED_PROXIES` (CIDRs/IPs): forwarded headers count only when the socket peer is in the list; any other peer is the client. Unset = any peer (the old behaviour; fine when only the platform proxy can reach the app).
- `TRUST_CF_CONNECTING_IP` (opt-in; `npm run tunnel` sets it) prefers Cloudflare's `CF-Connecting-IP` from a trusted peer. It is never on by default, because behind another proxy a client could forge it.
- The prod compose uses a fixed subnet `172.30.80.0/24` with `TRUSTED_PROXIES` set to it. Verified with `prod:up`: a local socket's peer is the gateway `172.30.80.1`.

**Web** (`src/profile/`, `src/screens/profile/`):
- `ProfileStore` (localStorage, parsed field by field), `ProfileApi` (fetch on `serverUrl()`, never throws: `ApiResult` with the API code or `NETWORK`), and `ProfilesProvider` (`App profiles={…}` injects it).
- Home and the join prompt call `profiles.prepare()` on mount. In the background it creates a profile with the placeholder nickname `t.profile.defaultNickname`, or replaces a key that was revoked by a transfer elsewhere.
- A click uses `profiles.seatKey(nickname)`: synchronous, so play never waits on the network; it renames in the background. Home pre-fills the nickname.
- Routes: `/profile` (mine: stats, recent games, transfer code with a clock-skew-free countdown, "I have a code"), `/profile/:id` (public) and `/leaderboard` (my row `aria-current`).
  - They are full pages like `/rules`, linked from Home (👤 next to the gear, and a leaderboard link). Never from inside a room.
  - Strings live in `he.ts` (`profile`, `leaderboard`, `apiErrors`).
- Unit tests block every `/api` fetch in `tests/setup.ts`. Browser tests stub `/api` with `stubProfileApi` and `seedProfile` (`tests/browser/harness.ts`): the hit test plus the phone audits at all 7 sizes.

**Tests:**
- Postgres suites need a reachable Postgres at `DATABASE_URL` (default `postgresql://durak:durak@127.0.0.1:5432/durak`), probed by `tests/helpers/postgres.ts`; without one they are skipped with a warning. `freshDatabase()` migrates a random schema with the real CLI and drops it afterwards.
- `results.postgres.test.ts`:
  - all-or-nothing writes;
  - a duplicate changes nothing;
  - an injected mid-transaction failure leaves no rows;
  - a deterministic overlap proves the row locks: it fails without `FOR UPDATE`.
- `socket.outage.test.ts`: a full game with Postgres unreachable.
- `socket.ratings.postgres.test.ts`: end to end over HTTP, socket and Postgres.

## Production (Phase 6 prep)
**Image** (`Dockerfile`, node:24-alpine, multi-stage):
- The build stage builds shared → game-engine → server → web.
- The runtime stage has only the server's production dependencies, with the workspace symlinks (`node_modules/@durak/*` → `packages/*`, so bot workers load `packages/game-engine/dist`), plus the four `dist` folders.
- It runs as `node`, with `PORT=8080`, a `HEALTHCHECK` on `/health`, and `CMD node apps/server/dist/index.js`.

**One process serves everything** on one origin: Socket.io, `/health` and the web client (`http/webApp.ts`, `@fastify/static`).
- `WEB_DIST_DIR`, or auto-detected `apps/web/dist`. The client isn't served when it isn't built.
- `/assets/*` are immutable-cached; `index.html` is `no-cache`.
- Every other GET falls back to `index.html`, except `/health`, `/socket.io`, `/api`, missing assets and non-GET requests (JSON 404).

**Config** (`config.ts`; the effective values are logged at startup as `settings`):
- `NODE_ENV=production` makes `CORS_ORIGINS` default to none (same-origin only). Otherwise it is `http://localhost:5173`. `*` is refused.
- The handshake's `allowRequest` accepts: no Origin, the server's own host, or a listed origin.
- `TRUST_PROXY`: `false` | `true` | a hop count (1 behind a typical platform proxy or the Cloudflare tunnel). It is used by Fastify and by `resolveClientIp()` (`transport/clientAddress.ts`). X-Forwarded-For is ignored unless trusted.
- `TRUSTED_PROXIES` (CIDRs) limits that trust to proxy peers; `TRUST_CF_CONNECTING_IP` prefers Cloudflare's header (see "Client IPs" under Phase 10).
- `DATABASE_URL` (optional) and `DB_MIGRATE_ON_START` (default true): Postgres for profiles and ratings.

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
- Deploy: `DEPLOY.md` (Hebrew). Today the Cloudflare tunnel above; permanent hosting is TBD (Azure via the GitHub Student Pack). `DEPLOY.md` lists what any host must provide (one always-on instance, Redis, optional Postgres, HTTPS, the env vars). `fly.toml` is a leftover and unused (Fly.io is paid). **Single instance only** (see above).

**CI** (`.github/workflows/ci.yml`):
- A typecheck → build → `npm test` job, with a Redis service.
- A docker job: builds the image, boots it with Redis and runs the smoke test.

## Development Workflow & Commands
- Build all workspaces: `npm run build --workspaces`
- Run every test: `npm test`. `scripts/run-tests.mjs` runs the workspaces in sequence with a hard per-workspace limit (`TEST_WORKSPACE_TIMEOUT_MS`, default 10 min): on expiry it kills the process tree and fails, naming the workspace. A test run must never hang. Always wrap long verification commands in a timeout.
- **Long synchronous tests (game-engine):** Vitest moves between tests with microtasks only, so a worker running back-to-back synchronous tests never reads the main process's RPC replies; once a file's synchronous work passes 60 s, birpc's timer fires (`Timeout calling "onTaskUpdate"`, exit 1) however idle the machine. `tests/setup/eventLoop.ts` (a `setupFiles` entry) yields one macrotask before every test and fails any single test that blocks for more than 20 s. Keep heavy property tests chunked (e.g. `tests/selfPlay.ts`: 10 games per test, run by `fuzz.podkidnoy.test.ts` / `fuzz.perevodnoy.test.ts`).
- Run engine tests: `npm test --workspace=packages/game-engine` (includes the bot tests in `tests/bot/`)
- Run the bot benchmark: `npm run bench --workspace=packages/game-engine` (`-- --full`, `-- --realtime`; see "Bot" above)
- Run server tests: `npm test --workspace=apps/server` (Redis tests need `docker-compose up -d` or any Redis at `REDIS_URL`; Postgres tests need a Postgres at `DATABASE_URL`, default `postgresql://durak:durak@127.0.0.1:5432/durak`; without them those suites are skipped with a warning. If the Postgres suites skip with "password authentication failed" although the compose Postgres is up, check who owns port 5432 (`Get-NetTCPConnection -LocalPort 5432 -State Listen`): a native Windows PostgreSQL service binds `0.0.0.0:5432` at boot, before Docker Desktop, so `127.0.0.1:5432` reaches it instead of the container. Stop that service or point `DATABASE_URL` at the container on another port. Separately, `POSTGRES_PASSWORD` only applies to an empty data dir; a compose volume created with another password can be reset in place with `docker exec durak-postgres psql -U durak -d durak -c "ALTER ROLE durak PASSWORD 'durak';"` (the container's local socket is trusted).)
- Run server + web together: `npm run dev` (builds `shared` + `game-engine` for the server's `tsx`, then runs both with `concurrently`; open http://localhost:5173)
- Run the server in dev mode: `npm run dev --workspace=apps/server` (env: `PORT`, `HOST`, `CORS_ORIGINS`, `TRUST_PROXY`, `BOT_WORKERS`, `BOT_JOB_TIMEOUT_MS`, the limits above, `WEB_DIST_DIR`; see `.env.example`; bot workers need a built `game-engine`)
- Run the web client alone: `npm run dev --workspace=apps/web`; tests: `npm test --workspace=apps/web` (Vitest + jsdom + Testing Library; `tests/sessions.test.ts` starts a real in-process server)
- Web real-browser tests (`apps/web/tests/browser/`): Vite dev server + a locally installed Chrome/Chromium/Edge via `playwright-core` (`CHROME_PATH` overrides the lookup; skipped with a warning when none is found). They check real hit-testing that jsdom can't see: every visible control on Home and `/rules` is the topmost element at its center, and a raw mouse click on Home's gear opens settings. `tests/browser/harness.ts` holds the shared setup (bounded startup/teardown, `withPage` always closes its context). `mobile.test.ts` emulates phones (touch, `isMobile`, 3x) at 360×740, 390×844 and, on their side, 740×360, 844×390, 932×430, 844×320 and 932×360 (Safari's toolbars take height): Home, settings, rules (both tabs), lobby, a crowded six-player table and game over have no horizontal scroll (the table: none at all), every control (inside the open modal, if any) is fully visible, ≥ 44 px and topmost at its center, taps on a hand card / a table card / Take / the gear work; in landscape the seat column is right of the table and Take / the piles left of it (RTL), the hand and table cards have minimum sizes, a simulated 47 px notch on either side (`--sai-left/right`) leaves no control, seat or card inside the inset, and a rotation 390×844 ↔ 844×390 mid-game keeps everything fitting with no console errors while a later bout's flights still reach the discard pile (`__fixture.advance()`); and the manifest, icons, `viewport-fit=cover` and `touch-action` are checked. Fixture scenarios: `crowded`, `crowded6`, `lobby`, `gameover`, `gameover-reload`. **Network-change retry:** on Windows with Docker Desktop, its virtual adapters can flap; Chrome then aborts in-flight requests with `net::ERR_NETWORK_CHANGED`, a Vite module fails to load and the app never mounts (measured: 1 in 140 page loads, no wait helps). `withPage` (`tests/browser/harness.ts`; every browser test uses it) retries the test body once on a fresh context only when the attempt failed AND a request failed with exactly that error, logging `[browser tests] retried: network changed (<url>)`; any other failure is rethrown unretried. Waits stay at the 5 s default: the stubbed `/api` data appears well under 1 s after load. A decorative element with a CSS `filter`/`transform`/`opacity` is its own stacking context and paints over an earlier `absolute` sibling: give overlaid controls a `z-*` and decorations `pointer-events-none`.
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
    - After 2 consecutive timeouts the player is marked AFK and the bot (medium) plays on their behalf until they move or resume (Phase 4b, see "Bots in games"). If the reconnection grace window expires, the player forfeits (see "Leaving a game": the game ends, or a bot takes the seat in 3+ player games).
    - Every auto-move (timeout or bot) goes through the same `validateMove` / `applyMove` path as a human move.
    - **Settings (env):** `TURN_TIMEOUT_MS` (30000), `AFK_TIMEOUT_MS` (5000, used when *every* awaited player is AFK), `RECONNECT_GRACE_MS` (60000), `RESTART_VOTE_MS` (30000), `RESTART_COOLDOWN_MS` (60000).
    - **Data model:** `StoredGame.turnDeadline` (epoch ms or null), `timeoutStreak`, `endReason` (`'normal' | 'forfeit' | 'abandoned' | 'restarted'`). `RoomMember.afk` (public, in `room:state`), plus server-only `consecutiveTimeouts` and `graceDeadline`. `game:state` carries `turnDeadline` and `serverTime`, so clients show a countdown free of clock skew; `game:over` carries `endReason`. Deadlines are persisted, so they survive restarts. The new codec fields have Zod defaults, so 3b records still decode.
    - **Turn timer** (one per game): armed on start and after every successful change (human move, timeout, or a resume that extends the deadline). On expiry, inside the room lock: a version mismatch → no-op (stale); woken early → re-arm; otherwise apply the timeout step, `version + 1`, save room + game atomically, broadcast, arm the next deadline. Finished or forfeited → cleared.
    - **AFK:** `consecutiveTimeouts` is incremented for each player whose timeout move was applied; at 2 → `afk = true`. A human move or `session:resume` resets both. A resume by an awaited player extends a short AFK deadline to a full turn.
    - **Abandon guard:** `StoredGame.timeoutStreak` counts consecutive expiries with no human move in between (any human move resets it). When it reaches `3 × players still in` (`services/timeoutPolicy.ts`), the game is abandoned: `durak = null`, `endReason = 'abandoned'`. Abandoned games are excluded from ELO (Phase 10). A real draw is `durak = null` with `endReason = 'normal'`.
    - **Reconnection grace:** a seated player who is still in, in a `playing` room, whose last socket disconnects gets `graceDeadline = now + RECONNECT_GRACE_MS`. Resume cancels it. On expiry (still offline, same deadline) the departure rule applies (`departSeat`, "Leaving a game"): in a 2-player game, or with no other human still in → `resign` → `endReason = 'forfeit'`, durak = the leaver; otherwise a medium bot takes over the seat and the game continues. Either way the player is added to `forfeits`. No grace in the lobby, after the game, or for a player who is already out. Disconnects caused by server shutdown never start a grace.
    - **Startup order:** ghost reset (everyone offline) → `buildServer` → `timers.rearmAll()` (re-arms every persisted deadline; past ones fire immediately; offline players without a grace get one) → `listen`.
    - **Testing:** `Clock` and `Scheduler` are injected (`services/scheduling.ts`). Tests use `tests/helpers/fakeTime.ts` (`advanceBy` / `runDue`), never real sleeps.
- **Phase 4: IS-MCTS AI Bot.** Implement determinized Monte Carlo Tree Search in `packages/game-engine/src/bot` with a configurable thinking time budget (e.g., 300ms per move) and benchmark win rates against a random baseline bot.
  - **4a (done):** the pure bot library: `PublicKnowledge`, determinization, SO-ISMCTS, Random/Greedy baselines, benchmark. See "Bot" above.
  - **4b (done):** server and web integration: bot seats, the worker pool, BotDriver, persisted knowledge, AFK takeover, and "play vs computer". See "Bots in games".
- **Phase 5: Mobile-First Web Client.** Build `apps/web` with clean card animations, responsive table layout for 2-6 players, and room invite links.
  - **5a (done):** playable client: home, invite links, lobby, table with legal-move highlighting, countdown, game over + rematch, spectators. See "Web Client" above.
  - **5b:** animations and visual polish.
- **Phase 10 (done): profiles, history and ratings.** Device profiles with a transfer code, Postgres + Prisma match history written in one idempotent transaction, pairwise ELO (K/(n−1)), the profile and leaderboard pages, trusted-proxy client IPs. See "Profiles, history and ratings".
- **Phase 9 (done): phones.** Phone/short-landscape layouts, 44 px targets, safe areas, the PWA, wake lock, vibration and instant resync on return. See "Phones" under "Web Client".
- **Phase 7 (done): player-feedback polish.** Leaving mid-game (forfeit or bot takeover), the restart vote, settings with synthesized sound and music, and the rules / interface guide / first-game tips. See "Leaving a game", "Restart vote" and "Web Client".
- **Phase 6: Deployment.**
  - **Prep (done):** production image, same-origin serving, prod compose, hardening (rate/abuse limits, proxy trust, CORS), CI, `DEPLOY.md`. See "Production".
  - **Now:** the Cloudflare Quick Tunnel (`npm run tunnel`). **Next:** permanent hosting, TBD (Azure via the GitHub Student Pack).

## Coding Conventions
- Prefer explicit union types and discriminated unions for game phases and move actions.
- Handle errors explicitly via Result objects or custom domain error classes rather than silent failures.
- Every bug fix in `packages/game-engine` must include a regression test in `packages/game-engine/tests/`.