import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The built web client (apps/web/dist), relative to this file: the same layout works from
 * src/ (tsx) and dist/ (node), in the repo and in the Docker image.
 */
export function defaultWebDistDir(): string {
  return fileURLToPath(new URL('../../../web/dist', import.meta.url));
}

/** The directory to serve, or null when there is no built client there. */
export function resolveWebDistDir(configured: string | null): string | null {
  const dir = resolve(configured ?? defaultWebDistDir());
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

/** Paths owned by the server itself: never answered with the SPA's index.html. */
const SERVER_PATHS = ['/socket.io', '/health', '/api'];

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function withSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply.headers(SECURITY_HEADERS);
}

/**
 * Serves the single-page web client on the same origin as Socket.io:
 * - /assets/* (Vite's content-hashed files) are cached forever;
 * - every other GET that isn't a file or a server path gets index.html (no-cache), so client
 *   routes like /room/:id work on a hard reload;
 * - unknown non-GET requests and server paths get a plain JSON 404.
 */
export function registerWebApp(app: FastifyInstance, root: string): void {
  // Not awaited: Fastify loads plugins in order before ready()/listen().
  void app.register(fastifyStatic, {
    root,
    wildcard: false, // routes for the files present at startup; everything else hits the 404 handler
    index: false,
    cacheControl: false,
    setHeaders: (res, path) => {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      const isHashedAsset = path.replaceAll('\\', '/').includes('/assets/');
      res.setHeader('cache-control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  const sendIndex = (reply: FastifyReply) =>
    withSecurityHeaders(reply).header('cache-control', 'no-cache').sendFile('index.html', root);

  app.get('/', (_request, reply) => sendIndex(reply));

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const isServerPath = SERVER_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
    const isAsset = path.startsWith('/assets/');
    if ((request.method === 'GET' || request.method === 'HEAD') && !isServerPath && !isAsset) {
      return sendIndex(reply);
    }
    return reply.code(404).send({ error: 'Not Found' });
  });
}
