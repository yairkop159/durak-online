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

## Development Workflow & Commands
- Build all workspaces: `npm run build --workspaces`
- Run engine tests: `npm test --workspace=packages/game-engine`
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