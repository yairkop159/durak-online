export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
}

export const DEFAULT_CORS_ORIGINS = ['http://localhost:5173'] as const;

export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : [...DEFAULT_CORS_ORIGINS];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
  };
}
