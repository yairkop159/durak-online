import { parseTrustProxy, type TrustProxy } from './transport/clientAddress.js';
import { DEFAULT_LIMITS, type LimitSettings } from './transport/rateLimit.js';

export type RepositoryKind = 'memory' | 'redis';

export interface ServerConfig {
  readonly production: boolean;
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
  readonly repository: RepositoryKind;
  readonly redisUrl: string | null;
  readonly redisPrefix: string;
  readonly turnTimeoutMs: number;
  readonly afkTimeoutMs: number;
  readonly reconnectGraceMs: number;
  /** Restart vote: time to answer, and the proposer's cooldown after a vote that did not pass. */
  readonly restartVoteMs: number;
  readonly restartCooldownMs: number;
  /** Bot worker threads; null = usable CPUs - 1, between 1 and 4 (cgroup-aware, bot/cpus.ts). */
  readonly botWorkers: number | null;
  readonly botJobTimeoutMs: number;
  /** Built web client to serve; null = auto-detect apps/web/dist next to the server. */
  readonly webDistDir: string | null;
  readonly trustProxy: TrustProxy;
  readonly limits: LimitSettings;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw} (positive integer)`);
  return value;
}

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw} (positive integer ms)`);
  return value;
}

export const DEFAULT_CORS_ORIGINS = ['http://localhost:5173'] as const;
export const DEFAULT_REDIS_PREFIX = 'durak:';

/**
 * Extra browser origins allowed to connect, besides the server's own origin (always allowed).
 * Unset: the Vite dev server in development, none in production (same-origin only).
 * "*" is refused: list origins explicitly.
 */
export function parseCorsOrigins(value: string | undefined, production = false): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);
  if (origins.includes('*')) throw new Error('CORS_ORIGINS="*" is not supported: list the allowed origins');
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS_ORIGINS entry "${origin}" (expected e.g. https://example.com)`);
    }
    if (url.origin !== origin) throw new Error(`Invalid CORS_ORIGINS entry "${origin}" (scheme://host[:port] only)`);
  }
  if (origins.length > 0) return origins;
  return production ? [] : [...DEFAULT_CORS_ORIGINS];
}

export function parseLimits(env: NodeJS.ProcessEnv): LimitSettings {
  return {
    eventBurst: positiveInt(env, 'RATE_LIMIT_BURST', DEFAULT_LIMITS.eventBurst),
    eventsPerSecond: positiveInt(env, 'RATE_LIMIT_PER_SEC', DEFAULT_LIMITS.eventsPerSecond),
    dropsBeforeDisconnect: positiveInt(env, 'RATE_LIMIT_DISCONNECT_AFTER', DEFAULT_LIMITS.dropsBeforeDisconnect),
    roomsPerIpPerHour: positiveInt(env, 'MAX_ROOMS_PER_IP_PER_HOUR', DEFAULT_LIMITS.roomsPerIpPerHour),
    maxRooms: positiveInt(env, 'MAX_ROOMS', DEFAULT_LIMITS.maxRooms),
    socketsPerIp: positiveInt(env, 'MAX_SOCKETS_PER_IP', DEFAULT_LIMITS.socketsPerIp),
  };
}

/** REPOSITORY wins if set; otherwise redis when REDIS_URL is present, else memory. */
export function resolveRepositoryKind(env: NodeJS.ProcessEnv): RepositoryKind {
  const explicit = env.REPOSITORY?.trim();
  if (explicit) {
    if (explicit !== 'memory' && explicit !== 'redis') {
      throw new Error(`Invalid REPOSITORY "${explicit}" (expected memory or redis)`);
    }
    return explicit;
  }
  return env.REDIS_URL?.trim() ? 'redis' : 'memory';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const repository = resolveRepositoryKind(env);
  const redisUrl = env.REDIS_URL?.trim() || null;
  if (repository === 'redis' && redisUrl === null) {
    throw new Error('REPOSITORY=redis requires REDIS_URL');
  }
  const production = env.NODE_ENV === 'production';
  return {
    production,
    port,
    host: env.HOST ?? '0.0.0.0',
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, production),
    repository,
    redisUrl,
    redisPrefix: env.REDIS_PREFIX?.trim() || DEFAULT_REDIS_PREFIX,
    turnTimeoutMs: positiveMs(env, 'TURN_TIMEOUT_MS', 30_000),
    afkTimeoutMs: positiveMs(env, 'AFK_TIMEOUT_MS', 5_000),
    reconnectGraceMs: positiveMs(env, 'RECONNECT_GRACE_MS', 60_000),
    restartVoteMs: positiveMs(env, 'RESTART_VOTE_MS', 30_000),
    restartCooldownMs: positiveMs(env, 'RESTART_COOLDOWN_MS', 60_000),
    botWorkers: env.BOT_WORKERS?.trim() ? positiveInt(env, 'BOT_WORKERS', 1) : null,
    botJobTimeoutMs: positiveMs(env, 'BOT_JOB_TIMEOUT_MS', 2_000),
    webDistDir: env.WEB_DIST_DIR?.trim() || null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    limits: parseLimits(env),
  };
}
