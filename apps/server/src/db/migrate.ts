import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/server (holds prisma.config.ts and prisma/), from src/db or dist/db alike. */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Hides a password in a connection URL (for logs and error messages). */
export function redactUrl(text: string, url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return text;
    return text.split(parsed.password).join('***').split(encodeURIComponent(parsed.password)).join('***');
  } catch {
    return text;
  }
}

/**
 * `prisma migrate deploy` against `url` (Prisma 7 has no programmatic migrate API; the CLI is a
 * runtime dependency). Applies pending migrations from apps/server/prisma/migrations; never
 * creates new ones. Rejects with the CLI's output tail (password redacted) on failure or timeout.
 */
export function runMigrations(url: string, timeoutMs = 60_000): Promise<string> {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`prisma migrate deploy timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = redactUrl(output.trim().split('\n').slice(-12).join('\n'), url);
      if (code === 0) resolvePromise(tail);
      else reject(new Error(`prisma migrate deploy failed (exit ${code}): ${tail}`));
    });
  });
}
