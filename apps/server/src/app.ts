import Fastify, { type FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import type { HealthReport } from './backend.js';
import type { BotPolicies, BotRunner } from './bot/job.js';
import { WorkerPoolRunner } from './bot/WorkerPoolRunner.js';
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
import { registerHandlers } from './transport/registerHandlers.js';
import { SocketNotifier } from './transport/SocketNotifier.js';
import type { IoServer } from './transport/socketTypes.js';

/** Max size of a single incoming Socket.io message. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export interface BotSettings {
  /** Worker threads (default: cores - 1, at least 1). */
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
  readonly logger?: boolean;
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
  const app = Fastify({ logger: options.logger ?? false });
  const repos = options.repos ?? createInMemoryRepositories();

  const io: IoServer = new Server(app.server, {
    cors: { origin: [...(options.corsOrigins ?? DEFAULT_CORS_ORIGINS)] },
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
  });

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
  const rooms = new RoomService({ repos, mutex, notifier, seedSource, now, timers, committer });
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
  registerHandlers({ io, rooms, games, log: app.log, isShuttingDown: () => shuttingDown });

  const health = options.health ?? (async (): Promise<HealthReport> => ({ ok: true, repository: 'memory' }));
  app.get('/health', async (_request, reply) => {
    const report = await health();
    return reply.code(report.ok ? 200 : 503).send(report);
  });

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
