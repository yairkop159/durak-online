import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Server } from 'socket.io';
import type { HealthReport } from './backend.js';
import type { BotPolicies, BotRunner } from './bot/job.js';
import type { Database, DbStatus } from './db/database.js';
import { WorkerPoolRunner } from './bot/WorkerPoolRunner.js';
import { DEFAULT_API_LIMITS, registerApi, type ApiLimits } from './http/api.js';
import { registerWebApp } from './http/webApp.js';
import { GameResultRecorder } from './ratings/GameResultRecorder.js';
import type { HistoryStore, ProfileStore, ResultStore } from './ratings/ports.js';
import { PrismaHistoryStore } from './ratings/PrismaHistoryStore.js';
import { PrismaProfileStore } from './ratings/PrismaProfileStore.js';
import { PrismaResultStore } from './ratings/PrismaResultStore.js';
import { ResultQueue, type ResultQueueSettings } from './ratings/ResultQueue.js';
import { DEFAULT_CORS_ORIGINS } from './config.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories } from './repositories/inMemory/index.js';
import { BotDriver, type BotPacing } from './services/BotDriver.js';
import { GameCommitter } from './services/GameCommitter.js';
import { GameService } from './services/GameService.js';
import { KeyedMutex } from './services/KeyedMutex.js';
import { cryptoSeedSource, type SeedSource } from './services/random.js';
import { ReactionService, type ReactionSettings } from './services/ReactionService.js';
import { DEFAULT_RESTART_VOTE_SETTINGS, RestartVoteService, type RestartVoteSettings } from './services/RestartVoteService.js';
import { RoomService } from './services/RoomService.js';
import { createSystemScheduler, systemClock, type Clock, type Scheduler } from './services/scheduling.js';
import { DEFAULT_TIMER_SETTINGS, TurnTimerService, type TimerSettings } from './services/TurnTimerService.js';
import {
  fastifyTrustProxy,
  isOriginAllowed,
  proxyPeerMatcher,
  resolveClientIp,
  type ClientIpPolicy,
  type TrustProxy,
} from './transport/clientAddress.js';
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
  readonly voteSettings?: Partial<RestartVoteSettings>;
  /** Runs bot decisions (default: a worker_threads pool; tests inject an InProcessRunner). */
  readonly botRunner?: BotRunner;
  readonly botSettings?: BotSettings;
  /** Backend health probe for GET /health (defaults to in-memory: always ok). */
  readonly health?: () => Promise<HealthReport>;
  /** Called after sockets and HTTP are closed (e.g. to quit Redis). */
  readonly onClose?: () => Promise<void>;
  /** Serve the built web client from this directory (with an SPA fallback). Default: not served. */
  readonly webDistDir?: string | null;
  /** Quick reactions: limits and bot behaviour (tests tune them). */
  readonly reactionSettings?: Partial<ReactionSettings>;
  /** Randomness for bot reactions in [0, 1) (default Math.random). */
  readonly reactionRandom?: () => number;
  /** Abuse limits (default DEFAULT_LIMITS). */
  readonly limits?: Partial<LimitSettings>;
  /** Reverse-proxy trust for client IPs (default false). */
  readonly trustProxy?: TrustProxy;
  /** Peers allowed to act as that proxy (CIDRs/IPs); null/absent = any peer. */
  readonly trustedProxies?: readonly string[] | null;
  /** Prefer CF-Connecting-IP from a trusted proxy peer (Cloudflare in front; default false). */
  readonly trustCfConnectingIp?: boolean;
  /**
   * Postgres for profiles, history and ratings (Phase 10). Optional: without it (or while it is
   * down) games run unchanged and /health reports `postgres: 'disabled' | 'down'` with status 200.
   */
  readonly database?: Database;
  /** Profiles (default: Postgres through `database`; tests inject MemoryProfileStore). */
  readonly profiles?: ProfileStore;
  /** /api abuse limits (default DEFAULT_API_LIMITS). */
  readonly apiLimits?: Partial<ApiLimits>;
  /** How long room:create/join waits for a device key lookup before seating unprofiled (default 500 ms). */
  readonly profileLookupMs?: number;
  /** Match history (default: Postgres through `database`; tests inject their own). */
  readonly results?: ResultStore;
  /** Public profiles and the leaderboard (default: Postgres through `database`). */
  readonly history?: HistoryStore;
  readonly resultQueueSettings?: Partial<ResultQueueSettings>;
}

export interface DurakServer {
  readonly app: FastifyInstance;
  readonly io: IoServer;
  readonly repos: Repositories;
  readonly rooms: RoomService;
  readonly games: GameService;
  readonly timers: TurnTimerService;
  readonly votes: RestartVoteService;
  readonly bots: BotDriver;
  readonly botRunner: BotRunner;
  readonly reactions: ReactionService;
  readonly profiles: ProfileStore;
  readonly recorder: GameResultRecorder;
  readonly resultQueue: ResultQueue;
}

export function buildServer(options: BuildServerOptions = {}): DurakServer {
  const ipPolicy: ClientIpPolicy = {
    trustProxy: options.trustProxy ?? false,
    trustedProxies: options.trustedProxies ?? null,
    cfConnectingIp: options.trustCfConnectingIp ?? false,
  };
  const isProxyPeer = proxyPeerMatcher(ipPolicy.trustedProxies);
  const app = Fastify({
    logger: options.logger ?? false,
    // The same policy as clientIpOf below, as proxy-addr's (address, hop) function.
    trustProxy: fastifyTrustProxy(ipPolicy),
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
      const proxied = ipPolicy.trustProxy !== false && ipPolicy.trustProxy !== 0 && isProxyPeer(req.socket.remoteAddress ?? '');
      const forwardedHost = proxied ? req.headers['x-forwarded-host'] : undefined;
      const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
      const allowed = isOriginAllowed(req.headers.origin, host, corsOrigins);
      if (!allowed) app.log.warn({ origin: req.headers.origin, host }, 'handshake refused: origin not allowed');
      callback(allowed ? null : 'Origin not allowed', allowed);
    },
  });
  /** The one client-address rule for sockets and HTTP (per-IP limits, logs). */
  const clientIpOf = (peer: string, headers: Readonly<Record<string, string | string[] | undefined>>) =>
    resolveClientIp(peer, headers, ipPolicy, isProxyPeer);
  const ipOf = (socket: { handshake: { address: string; headers: Record<string, string | string[] | undefined> } }) =>
    clientIpOf(socket.handshake.address, socket.handshake.headers);

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

  // Match history (Phase 10): queued off the game path, written to Postgres when it is there.
  const database = options.database ?? null;
  const results = options.results ?? new PrismaResultStore(() => database?.client() ?? null);
  const resultQueue = new ResultQueue({
    store: results,
    clock,
    scheduler,
    log: app.log,
    ...(options.resultQueueSettings ? { settings: options.resultQueueSettings } : {}),
  });
  const recorder = new GameResultRecorder({
    queue: resultQueue,
    clock,
    enabled: () => options.results !== undefined || (database?.configured ?? false),
  });

  // Wiring order: the committer reports to the BotDriver, which applies moves through GameService,
  // which commits through the committer — so the listeners are bound late.
  let bots: BotDriver | null = null;
  const reactions = new ReactionService({
    repos,
    notifier,
    clock,
    scheduler,
    ...(options.reactionRandom ? { random: options.reactionRandom } : {}),
    ...(options.reactionSettings ? { settings: options.reactionSettings } : {}),
  });
  const committer = new GameCommitter({
    repos,
    notifier,
    timers,
    listeners: () => (bots ? [bots, reactions, recorder] : [reactions, recorder]),
  });
  timers.attachCommitter(committer);

  const now = () => clock.now();
  const seedSource = options.seedSource ?? cryptoSeedSource;
  const votes = new RestartVoteService({
    repos,
    mutex,
    notifier,
    clock,
    scheduler,
    settings: { ...DEFAULT_RESTART_VOTE_SETTINGS, ...options.voteSettings },
    committer,
    seedSource,
    log: app.log,
    onRestarted: (room, game) => recorder.recordEnded(room, game),
  });
  const rooms = new RoomService({ repos, mutex, notifier, seedSource, now, timers, committer, votes, maxRooms: limits.maxRooms });
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

  const profiles = options.profiles ?? new PrismaProfileStore(() => database?.client() ?? null);
  const profileLookupMs = options.profileLookupMs ?? 500;
  /** Seat → profile, bounded: a slow or dead Postgres only means an unrated seat. */
  const resolveProfile = async (deviceKey: string | undefined): Promise<string | null> => {
    if (deviceKey === undefined) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = profiles.resolveKey(deviceKey).then((p) => p?.profileId ?? null);
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), profileLookupMs);
        timer.unref();
      });
      return await Promise.race([lookup, timeout]);
    } catch (error) {
      app.log.warn({ err: error instanceof Error ? error.name : 'Error' }, 'profile lookup failed: seating unprofiled');
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let shuttingDown = false;
  registerHandlers({
    io,
    rooms,
    games,
    votes,
    reactions,
    log: app.log,
    isShuttingDown: () => shuttingDown,
    limits,
    now,
    ipOf,
    resolveProfile,
  });

  registerApi(app, {
    profiles,
    history: options.history ?? new PrismaHistoryStore(() => database?.client() ?? null),
    clientIpOf,
    now,
    corsOrigins,
    limits: { ...DEFAULT_API_LIMITS, ...options.apiLimits },
    log: app.log,
  });

  const health = options.health ?? (async (): Promise<HealthReport> => ({ ok: true, repository: 'memory' }));
  // Probed every few seconds by Docker and the hosting platform: keep it out of the info log.
  // Only the game store (Redis) decides 503; Postgres being down never takes the server out.
  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    const [report, postgres] = await Promise.all([
      health(),
      database ? database.health() : Promise.resolve<DbStatus>('disabled'),
    ]);
    return reply.code(report.ok ? 200 : 503).send({ ...report, postgres });
  });
  if (options.webDistDir) registerWebApp(app, options.webDistDir);

  // Shutdown: stop all timers and bots, then drop sockets. Disconnects caused by our own shutdown
  // must not start reconnection graces (players are offline because the server is, not by choice).
  app.addHook('preClose', async () => {
    shuttingDown = true;
    timers.dispose();
    votes.dispose();
    driver.dispose();
    reactions.dispose();
    await botRunner.dispose();
    io.disconnectSockets(true);
    io.engine.close();
  });
  // Postgres (re)connected: write what waited, and re-submit finished games still in the game
  // store (a crash between game:over and the write). Idempotent by gameId.
  database?.onReady(() => {
    resultQueue.kick();
    recorder
      .resubmitFinished(repos)
      .then((count) => app.log.info({ count }, 'finished games re-submitted to the match history'))
      .catch((error: unknown) => app.log.warn({ err: error instanceof Error ? error.name : 'Error' }, 're-submission failed'));
  });

  const onClose = options.onClose;
  app.addHook('onClose', async () => {
    await resultQueue.flush(3_000);
    resultQueue.dispose();
    if (database) await database.close();
    if (onClose) await onClose();
  });

  return { app, io, repos, rooms, games, timers, votes, bots: driver, botRunner, reactions, profiles, recorder, resultQueue };
}
