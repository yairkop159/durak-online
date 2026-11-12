export type RepositoryKind = 'memory' | 'redis';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
  readonly repository: RepositoryKind;
  readonly redisUrl: string | null;
  readonly redisPrefix: string;
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
  };
}
