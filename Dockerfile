# syntax=docker/dockerfile:1
# Production image: one Node process serving the built web client, the HTTP API (/health) and
# Socket.io on the same origin. Build: docker build -t durak-online .

ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------- build: every workspace
FROM node:${NODE_VERSION} AS build
WORKDIR /app

# Manifests first, so `npm ci` stays cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/game-engine/package.json packages/game-engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# The npm cache lives in a BuildKit cache mount: a changed lockfile reinstalls from local tarballs
# instead of the network. It never reaches a layer, so the image doesn't grow; `npm ci` still installs
# exactly the lockfile (integrity-checked), so the build stays reproducible.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Order matters (workspaces order): shared -> game-engine -> server -> web.
# VITE_SERVER_URL is optional: by default the client connects to the origin that served it.
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
RUN npm run build

# ---------------------------------------------------------------- runtime deps: server only
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/game-engine/package.json packages/game-engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Production dependencies of the server and the workspaces it links (shared, game-engine).
# This includes the Prisma CLI (`migrate deploy` runs at startup), whose postinstall fetches the
# schema engine for this platform (linux-musl).
# node_modules/@durak/* are symlinks to packages/*, which is how the bot worker threads load
# the built engine (`import '@durak/game-engine'` -> packages/game-engine/dist).
# Same npm cache mount as the build stage (no `npm cache clean`: the cache is never in the layer).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --prefer-offline --workspace=apps/server

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    CHECKPOINT_DISABLE=1
WORKDIR /app

COPY --from=deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/packages/game-engine/dist packages/game-engine/dist
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
# Postgres migrations (applied at startup by `prisma migrate deploy`, src/db/migrate.ts).
COPY --from=build --chown=node:node /app/apps/server/prisma apps/server/prisma
COPY --from=build --chown=node:node /app/apps/server/prisma.config.ts apps/server/prisma.config.ts
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Node is PID 1 and handles SIGTERM itself (graceful shutdown: sockets -> HTTP -> Postgres -> Redis).
CMD ["node", "apps/server/dist/index.js"]
