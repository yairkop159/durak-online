// @vitest-environment node
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { ICON_FILES, renderIcon } from '../build/icons';
import { PNG_SIGNATURE, crc32, encodePng } from '../build/png';
import { APP_NAME, APP_SHORT_NAME, manifest, pwaFiles, serviceWorkerSource } from '../build/pwa';
import { readThemeColors } from '../build/theme';

const theme = readThemeColors();
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Decodes the PNGs our encoder writes (RGBA, filter 0) and checks every chunk's CRC. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (;;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len), `${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 4)]).toBe(0);
    raw.copy(rgba, y * width * 4, y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4));
  }
  return { width, height, rgba };
}

describe('PNG encoder', () => {
  it('round-trips pixels', () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const { width, height, rgba } = decodePng(encodePng(2, 2, pixels));
    expect([width, height]).toEqual([2, 2]);
    expect([...rgba]).toEqual([...pixels]);
  });

  it('rejects a wrong buffer size', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });
});

describe('icons', () => {
  it('are deterministic', () => {
    expect(Buffer.from(renderIcon(48, theme, { fullBleed: false })).equals(Buffer.from(renderIcon(48, theme, { fullBleed: false })))).toBe(true);
  });

  it('decode at their stated sizes; the "any" icon has transparent corners, full-bleed ones none', () => {
    const files = pwaFiles(theme);
    for (const icon of ICON_FILES) {
      const file = files.find((f) => f.path === icon.path)!;
      const { width, height, rgba } = decodePng(file.body as Buffer);
      expect([width, height]).toEqual([icon.size, icon.size]);
      const cornerAlpha = rgba[3];
      const centerAlpha = rgba[((icon.size >> 1) * icon.size + (icon.size >> 1)) * 4 + 3];
      expect(centerAlpha).toBe(255);
      if (icon.purpose === 'maskable' || icon.purpose === 'apple') expect(cornerAlpha).toBe(255);
      else expect(cornerAlpha).toBe(0);
    }
  });
});

describe('manifest', () => {
  it('is an installable, standalone Hebrew app in the theme colors', () => {
    const m = manifest(theme);
    expect(m).toMatchObject({
      name: APP_NAME,
      short_name: APP_SHORT_NAME,
      lang: 'he',
      dir: 'rtl',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: theme.bg0,
      theme_color: theme.bg0,
    });
    const icons = m.icons as { sizes: string; purpose: string }[];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('the theme colors come from theme.css', () => {
    const css = readFileSync(new URL('../src/theme/theme.css', import.meta.url), 'utf8');
    expect(css).toContain(`--color-bg-0: ${theme.bg0};`);
  });
});

describe('index.html', () => {
  it('lets the page extend under the notch (viewport-fit=cover: otherwise env(safe-area-inset-*) is 0 on iOS)', () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(indexHtml)?.[1] ?? '';
    expect(viewport.split(',').map((s) => s.trim())).toContain('viewport-fit=cover');
  });

  it('links the manifest and icons, and its theme-color is the theme background', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('href="/icons/apple-touch-icon.png"');
    expect(indexHtml).toContain(`<meta name="theme-color" content="${theme.bg0}" />`);
    const paths = pwaFiles(theme).map((f) => `/${f.path}`);
    for (const href of indexHtml.matchAll(/href="(\/[^"]+)"/g)) expect(paths).toContain(href[1]);
  });
});

/** Runs the generated service worker against fake `self`, `caches` and `fetch`. */
function loadServiceWorker(fetchImpl: (req: unknown) => Promise<unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const store = new Map<string, Map<string, unknown>>([['durak-shell-old', new Map()]]);
  const caches = {
    open: vi.fn(async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name)!;
      return { addAll: vi.fn(async (urls: string[]) => urls.forEach((u) => cache.set(u, `cached:${u}`))) };
    }),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (name: string) => store.delete(name)),
    match: vi.fn(async (url: string) => [...store.values()].find((c) => c.has(url))?.get(url)),
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  class FakeResponse {
    constructor(
      readonly body: string,
      readonly init: { status: number },
    ) {}
  }
  const source = serviceWorkerSource('v1', ['/offline.html', '/icons/icon-192.png']);
  new Function('self', 'caches', 'fetch', 'Response', source)(self, caches, fetchImpl, FakeResponse);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<unknown> | undefined;
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p), respondWith: (p: Promise<unknown>) => (responded = p) });
    await waited;
    return responded;
  };
  return { dispatch, store, self };
}

describe('service worker', () => {
  it('precaches the offline page into a versioned cache and drops older ones', async () => {
    const sw = loadServiceWorker(async () => 'net');
    await sw.dispatch('install', {});
    expect(sw.store.get('durak-shell-v1')?.has('/offline.html')).toBe(true);
    await sw.dispatch('activate', {});
    expect([...sw.store.keys()]).toEqual(['durak-shell-v1']);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it('navigations go to the network; offline they get the offline page', async () => {
    let online = true;
    const sw = loadServiceWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return 'network page';
    });
    await sw.dispatch('install', {});
    const navigate = { request: { mode: 'navigate', method: 'GET', url: '/room/abc' } };
    await expect(sw.dispatch('fetch', navigate)).resolves.toBe('network page');
    online = false;
    await expect(sw.dispatch('fetch', navigate)).resolves.toBe('cached:/offline.html');
  });

  it('never touches assets, socket.io or anything that is not a navigation', async () => {
    const fetchImpl = vi.fn(async () => 'net');
    const sw = loadServiceWorker(fetchImpl);
    for (const request of [
      { mode: 'cors', method: 'GET', url: '/assets/index-abc.js' },
      { mode: 'cors', method: 'GET', url: '/socket.io/?EIO=4' },
      { mode: 'navigate', method: 'POST', url: '/' },
    ]) {
      await expect(sw.dispatch('fetch', { request })).resolves.toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
