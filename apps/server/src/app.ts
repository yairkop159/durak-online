import Fastify, { type FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import type { HealthReport } from './backend.js';
import { DEFAULT_CORS_ORIGINS } from './config.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories } from './repositories/inMemory/index.js';
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
  const now = () => clock.now();
  const seedSource = options.seedSource ?? cryptoSeedSource;
  const rooms = new RoomService({ repos, mutex, notifier, seedSource, now, timers });
  const games = new GameService({ repos, mutex, notifier, timers });

  let shuttingDown = false;
  registerHandlers({ io, rooms, games, log: app.log, isShuttingDown: () => shuttingDown });

  const health = options.health ?? (async (): Promise<HealthReport> => ({ ok: true, repository: 'memory' }));
  app.get('/health', async (_request, reply) => {
    const report = await health();
    return reply.code(report.ok ? 200 : 503).send(report);
  });

  // Shutdown: stop all timers, then drop sockets. Disconnects caused by our own shutdown must not
  // start reconnection graces (players are offline because the server is, not by choice).
  app.addHook('preClose', async () => {
    shuttingDown = true;
    timers.dispose();
    io.disconnectSockets(true);
    io.engine.close();
  });
  const onClose = options.onClose;
  if (onClose) app.addHook('onClose', async () => onClose());

  return { app, io, repos, rooms, games, timers };
}
