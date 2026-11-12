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

## Development Workflow & Commands
- Build all workspaces: `npm run build --workspaces`
- Run engine tests: `npm test --workspace=packages/game-engine`
- Start local infrastructure: `docker-compose up -d`

## Implementation Roadmap (Execute Step-by-Step)
- **Phase 1: Foundation & Shared Contracts.** Initialize monorepo, `tsconfig.base.json`, `docker-compose.yml` (Redis + Postgres), and `packages/shared` types + Zod event schemas.
- **Phase 2: Pure Durak Engine & Test Suite.** Build `packages/game-engine` (deck, attack/defense/throw-in validation, draw order, tie-breakers, state sanitizer). Write comprehensive Vitest unit tests covering all edge cases before writing any server code.
- **Phase 3: Real-Time Server & Persistence.** Build `apps/server` with Fastify + Socket.io, Redis room repository, session reconnection logic, and PostgreSQL match persistence.
- **Phase 4: IS-MCTS AI Bot.** Implement determinized Monte Carlo Tree Search in `packages/game-engine/src/bot` with a configurable thinking time budget (e.g., 300ms per move) and benchmark win rates against a random baseline bot.
- **Phase 5: Mobile-First Web Client.** Build `apps/web` with clean card animations, responsive table layout for 2-6 players, and room invite links.

## Coding Conventions
- Prefer explicit union types and discriminated unions for game phases and move actions.
- Handle errors explicitly via Result objects or custom domain error classes rather than silent failures.
- Every bug fix in `packages/game-engine` must include a regression test in `packages/game-engine/tests/`.