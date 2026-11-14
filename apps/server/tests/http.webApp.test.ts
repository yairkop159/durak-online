import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type DurakServer } from '../src/app.js';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { resolveWebDistDir } from '../src/http/webApp.js';

const INDEX = '<!doctype html><title>durak</title>';
let dir: string;
let server: DurakServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'durak-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  // The PWA files the web build emits at the root (apps/web/build/pwa.ts).
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"durak"}');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'offline.html'), '<!doctype html><title>offline</title>');
  writeFileSync(join(dir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'icons', 'apple-touch-icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  server = buildServer({ webDistDir: dir, botRunner: new InProcessRunner() });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serving the web client', () => {
  it('serves index.html at / without caching', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('falls back to index.html for client routes like /room/:id (hard reload)', async () => {
    for (const url of ['/room/abcd1234', '/room/abcd1234?x=1', '/anything/else']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX);
    }
  });

  it('serves hashed assets with a long-lived cache and other files without', async () => {
    const asset = await server.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const icon = await server.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('serves the PWA files as themselves (right type, revalidated), not the SPA fallback', async () => {
    const expected: Record<string, RegExp> = {
      '/manifest.webmanifest': /^application\/manifest\+json/,
      '/sw.js': /javascript/,
      '/offline.html': /text\/html/,
      '/icons/icon-192.png': /^image\/png/,
      // iOS "Add to Home Screen" reads the apple-touch-icon link, not the manifest's icons.
      '/icons/apple-touch-icon.png': /^image\/png/,
    };
    for (const [url, type] of Object.entries(expected)) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(type);
      // A new deploy's service worker / manifest must be picked up: never long-cached.
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.body, url).not.toBe(INDEX);
    }
  });

  it('the PWA start_url and scope ("/") answer 200 directly: no redirect, so an installed app starts inside its scope', async () => {
    for (const url of ['/', '/?source=pwa', '/room/abcd1234']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers.location, url).toBeUndefined();
    }
  });

  it('a missing asset is a real 404, not index.html', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/assets/gone.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<title>');
  });

  it('keeps /health and non-GET requests out of the fallback', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ ok: true });
    expect((await server.app.inject({ method: 'GET', url: '/health/x' })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: '/room/abcd1234' })).statusCode).toBe(404);
  });

  it('does not escape the web root', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/assets/..%2f..%2fpackage.json' });
    expect(res.body).not.toContain('"name"');
  });
});

describe('resolveWebDistDir', () => {
  it('returns the directory only when it holds an index.html', () => {
    expect(resolveWebDistDir(dir)).toBe(dir);
    expect(resolveWebDistDir(join(dir, 'assets'))).toBeNull();
  });
});
