import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Server } from 'socket.io';
import type { HealthReport } from './backend.js';
import type { BotPolicies, BotRunner } from './bot/job.js';
import { WorkerPoolRunner } from './bot/WorkerPoolRunner.js';
import { registerWebApp } from './http/webApp.js';
import { DEFAULT_CORS_ORIGINS } from './config.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories } from './repositories/inMemory/index.js';
import { BotDriver, type BotPacing } from './services/BotDriver.js';
import { GameCommitter } from './services/GameCommitter.js';
import { GameService } from './services/GameService.js';
import { KeyedMutex } from './services/KeyedMutex.js';
import { cryptoSeedSource, type SeedSource } from './services/random.js';
import { RoomService } from './services/RoomService.js';
import { createSystemScheduler, systemClock, type Clock, type Scheduler } from './services/scheduling.js';
import { DEFAULT_TIMER_SETTINGS, TurnTimerService, type TimerSettings } from './services/TurnTimerService.js';
import { clientIp, isOriginAllowed, type TrustProxy } from './transport/clientAddress.js';
import { DEFAULT_LIMITS, type LimitSettings } from './transport/rateLimit.js';
import { registerHandlers } from './transport/registerHandlers.js';
import { SocketNotifier } from './transport/SocketNotifier.js';
import type { IoServer } from './transport/socketTypes.js';

/** Max size of a single incoming Socket.io message. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export interface BotSettings {
  /** Worker threads (default: usable CPUs - 1, between 1 and 4; see bot/cpus.ts). */
  readonly workers?: number;
  /** Per-job timeout before the GreedyBot fallback (default 2000 ms). */
  readonly jobTimeoutMs?: number;
  /** Difficulty -> decision policy (tests use small iteration budgets). */
  readonly policies?: BotPolicies;
  readonly pacing?: BotPacing;
  /** Pacing randomness in [0, 1) (default Math.random). */
  readonly random?: () => number;
  /** Search seeds (default: crypto). */
  readonly seedSource?: SeedSource;
  /** Bot plays for AFK humans (default true). */
  readonly afkTakeover?: boolean;
}

export const DEFAULT_BOT_JOB_TIMEOUT_MS = 2_000;

export interface BuildServerOptions {
  readonly repos?: Repositories;
  readonly seedSource?: SeedSource;
  readonly corsOrigins?: readonly string[];
  /** true = Fastify's default logger; tests pass `{ level, stream }` to capture log lines. */
  readonly logger?: FastifyServerOptions['logger'];
  /** Time source for deadlines and timestamps (tests inject a fake clock). */
  readonly clock?: Clock;
  /** Timer backend (tests inject a fake scheduler; default: setTimeout). */
  readonly scheduler?: Scheduler;
  readonly timerSettings?: Partial<TimerSettings>;
  /** Runs bot decisions (default: a worker_threads pool; tests inject an InProcessRunner). */
  readonly botRunner?: BotRunner;
  readonly botSettings?: BotSettings;
  /** Backend health probe for GET /health (defaults to in-memory: always ok). */
  readonly health?: () => Promise<HealthReport>;
  /** Called after sockets and HTTP are closed (e.g. to quit Redis). */
  readonly onClose?: () => Promise<void>;
  /** Serve the built web client from this directory (with an SPA fallback). Default: not served. */
  readonly webDistDir?: string | null;
  /** Abuse limits (default DEFAULT_LIMITS). */
  readonly limits?: Partial<LimitSettings>;
  /** Reverse-proxy trust for client IPs (default false). */
  readonly trustProxy?: TrustProxy;
}

export interface DurakServer {
  readonly app: FastifyInstance;
  readonly io: IoServer;
  readonly repos: Repositories;
  readonly rooms: RoomService;
  readonly games: GameService;
  readonly timers: TurnTimerService;
  readonly bots: BotDriver;
  readonly botRunner: BotRunner;
}

export function buildServer(options: BuildServerOptions = {}): DurakServer {
  const trustProxy = options.trustProxy ?? false;
  const app = Fastify({
    logger: options.logger ?? false,
    // A hop count becomes proxy-addr's own hop function (Fastify's types only take boolean/fn).
    trustProxy: typeof trustProxy === 'number' ? (_address: string, hop: number) => hop < trustProxy : trustProxy,
  });
  const repos = options.repos ?? createInMemoryRepositories();
  const limits: LimitSettings = { ...DEFAULT_LIMITS, ...options.limits };

  // Never leak internals over HTTP: 5xx bodies are generic, details only go to the log.
  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: error.message ?? 'Bad Request' });
  });

  const corsOrigins = [...(options.corsOrigins ?? DEFAULT_CORS_ORIGINS)];
  const io: IoServer = new Server(app.server, {
    // CORS only matters for cross-origin long-polling; same-origin needs no headers at all.
    ...(corsOrigins.length > 0 ? { cors: { origin: corsOrigins } } : {}),
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    // WebSockets bypass CORS, so the handshake checks Origin itself.
    allowRequest: (req, callback) => {
      const forwardedHost = trustProxy !== false ? req.headers['x-forwarded-host'] : undefined;
      const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
      const allowed = isOriginAllowed(req.headers.origin, host, corsOrigins);
      if (!allowed) app.log.warn({ origin: req.headers.origin, host }, 'handshake refused: origin not allowed');
      callback(allowed ? null : 'Origin not allowed', allowed);
    },
  });
  const ipOf = (socket: { handshake: { address: string; headers: Record<string, string | string[] | undefined> } }) =>
    clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for'], trustProxy);

  const clock = options.clock ?? systemClock;
  const scheduler =
    options.scheduler ?? createSystemScheduler(clock, (error) => app.log.error({ err: error }, 'timer callback failed'));
  const mutex = new KeyedMutex();
  const notifier = new SocketNotifier(io, clock);
  const timers = new TurnTimerService({
    repos,
    mutex,
    notifier,
    clock,
    scheduler,
    settings: { ...DEFAULT_TIMER_SETTINGS, ...options.timerSettings },
    log: app.log,
  });

  // Wiring order: the committer reports to the BotDriver, which applies moves through GameService,
  // which commits through the committer — so the listener is bound late.
  let bots: BotDriver | null = null;
  const committer = new GameCommitter({ repos, notifier, timers, listener: () => bots });
  timers.attachCommitter(committer);

  const now = () => clock.now();
  const seedSource = options.seedSource ?? cryptoSeedSource;
  const rooms = new RoomService({ repos, mutex, notifier, seedSource, now, timers, committer, maxRooms: limits.maxRooms });
  const games = new GameService({ repos, mutex, notifier, committer });

  const botSettings = options.botSettings ?? {};
  const botRunner =
    options.botRunner ??
    new WorkerPoolRunner({
      ...(botSettings.workers !== undefined ? { size: botSettings.workers } : {}),
      jobTimeoutMs: botSettings.jobTimeoutMs ?? DEFAULT_BOT_JOB_TIMEOUT_MS,
      clock,
      scheduler,
      log: app.log,
    });
  const driver = new BotDriver({
    runner: botRunner,
    moves: games,
    clock,
    scheduler,
    seedSource: botSettings.seedSource ?? cryptoSeedSource,
    log: app.log,
    ...(botSettings.policies ? { policies: botSettings.policies } : {}),
    ...(botSettings.pacing ? { pacing: botSettings.pacing } : {}),
    ...(botSettings.random ? { random: botSettings.random } : {}),
    ...(botSettings.afkTakeover !== undefined ? { afkTakeover: botSettings.afkTakeover } : {}),
  });
  bots = driver;

  let shuttingDown = false;
  registerHandlers({ io, rooms, games, log: app.log, isShuttingDown: () => shuttingDown, limits, now, ipOf });

  const health = options.health ?? (async (): Promise<HealthReport> => ({ ok: true, repository: 'memory' }));
  // Probed every few seconds by Docker and the hosting platform: keep it out of the info log.
  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    const report = await health();
    return reply.code(report.ok ? 200 : 503).send(report);
  });
  if (options.webDistDir) registerWebApp(app, options.webDistDir);

  // Shutdown: stop all timers and bots, then drop sockets. Disconnects caused by our own shutdown
  // must not start reconnection graces (players are offline because the server is, not by choice).
  app.addHook('preClose', async () => {
    shuttingDown = true;
    timers.dispose();
    driver.dispose();
    await botRunner.dispose();
    io.disconnectSockets(true);
    io.engine.close();
  });
  const onClose = options.onClose;
  if (onClose) app.addHook('onClose', async () => onClose());

  return { app, io, repos, rooms, games, timers, bots: driver, botRunner };
}
