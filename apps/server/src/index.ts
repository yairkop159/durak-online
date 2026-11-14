import { buildServer } from './app.js';
import { defaultPoolSize } from './bot/WorkerPoolRunner.js';
import { createBackend } from './backend.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { createSystemScheduler, systemClock } from './services/scheduling.js';
import { resolveWebDistDir } from './http/webApp.js';

const config = loadConfig();

// Logger for the bootstrap phase, before Fastify (and its logger) exists.
const bootLog = {
  info: (obj: object, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj: object, msg: string) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj: object, msg: string) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

const backend = await createBackend(config, bootLog);
await backend.startup();

const webDistDir = resolveWebDistDir(config.webDistDir);

// Postgres (profiles, history, ratings) is optional and never blocks startup or games: the first
// attempt runs in the background after listen, and a failure is retried (src/db/database.ts).
let dbLog: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void } = bootLog;
const database = createDatabase({
  url: config.databaseUrl,
  migrateOnStart: config.dbMigrateOnStart,
  log: { info: (obj, msg) => dbLog.info(obj, msg), warn: (obj, msg) => dbLog.warn(obj, msg) },
  clock: systemClock,
  scheduler: createSystemScheduler(systemClock, (error) => bootLog.error({ err: String(error) }, 'database retry failed')),
});

const { app, timers, votes } = buildServer({
  repos: backend.repos,
  corsOrigins: config.corsOrigins,
  logger: true,
  timerSettings: {
    turnTimeoutMs: config.turnTimeoutMs,
    afkTimeoutMs: config.afkTimeoutMs,
    reconnectGraceMs: config.reconnectGraceMs,
  },
  voteSettings: { restartVoteMs: config.restartVoteMs, restartCooldownMs: config.restartCooldownMs },
  botSettings: {
    ...(config.botWorkers !== null ? { workers: config.botWorkers } : {}),
    jobTimeoutMs: config.botJobTimeoutMs,
  },
  health: () => backend.health(),
  onClose: () => backend.close(),
  webDistDir,
  trustProxy: config.trustProxy,
  limits: config.limits,
  database,
});
dbLog = app.log;
app.log.info({ repository: backend.kind }, 'storage backend ready');
app.log.info(
  {
    production: config.production,
    corsOrigins: config.corsOrigins,
    trustProxy: config.trustProxy,
    botWorkers: config.botWorkers ?? defaultPoolSize(),
    limits: config.limits,
    postgres: config.databaseUrl ? 'configured' : 'disabled (no DATABASE_URL)',
    dbMigrateOnStart: config.dbMigrateOnStart,
  },
  'settings',
);
app.log.info({ webDistDir }, webDistDir ? 'serving the web client' : 'web client not built: API and sockets only');

// After the ghost reset (backend.startup): re-arm persisted turn deadlines, start
// reconnection graces for players who were online when the previous process died, and let bots
// plan for every running game.
app.log.info(await timers.rearmAll(), 're-armed timers');
app.log.info({ votes: await votes.rearmAll() }, 're-armed restart votes');

let stopping = false;
const shutdown = async (signal: string, code = 0) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // Never hang on the way out (the platform would SIGKILL us anyway).
  setTimeout(() => process.exit(code || 1), 10_000).unref();
  try {
    await app.close(); // closes sockets, HTTP, then Postgres and the backend (Redis)
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
  }
  process.exit(code);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Last-resort guards: log, never print a raw stack to clients. A stray rejection is logged and the
// server keeps running; an uncaught exception leaves the process in an unknown state, so it shuts
// down cleanly and the platform restarts it (state is in Redis; clients resume their sessions).
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await database.close();
  await backend.close();
  process.exit(1);
}
void database.start();
