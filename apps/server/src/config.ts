export type RepositoryKind = 'memory' | 'redis';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
  readonly repository: RepositoryKind;
  readonly redisUrl: string | null;
  readonly redisPrefix: string;
  readonly turnTimeoutMs: number;
  readonly afkTimeoutMs: number;
  readonly reconnectGraceMs: number;
  /** Bot worker threads; null = cores - 1 (min 1). */
  readonly botWorkers: number | null;
  readonly botJobTimeoutMs: number;
  /** Built web client to serve; null = auto-detect apps/web/dist next to the server. */
  readonly webDistDir: string | null;
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

export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : [...DEFAULT_CORS_ORIGINS];
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
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    repository,
    redisUrl,
    redisPrefix: env.REDIS_PREFIX?.trim() || DEFAULT_REDIS_PREFIX,
    turnTimeoutMs: positiveMs(env, 'TURN_TIMEOUT_MS', 30_000),
    afkTimeoutMs: positiveMs(env, 'AFK_TIMEOUT_MS', 5_000),
    reconnectGraceMs: positiveMs(env, 'RECONNECT_GRACE_MS', 60_000),
    botWorkers: env.BOT_WORKERS?.trim() ? positiveMs(env, 'BOT_WORKERS', 1) : null,
    botJobTimeoutMs: positiveMs(env, 'BOT_JOB_TIMEOUT_MS', 2_000),
    webDistDir: env.WEB_DIST_DIR?.trim() || null,
  };
}
