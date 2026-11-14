/**
 * Shared setup for the real-browser tests: a locally installed Chrome/Chromium/Edge (CHROME_PATH
 * overrides the lookup) driven by playwright-core, and an in-process Vite dev server.
 * Every helper is bounded: a test run must never hang (see the 60 s startup/teardown bounds).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);

export const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) console.warn('[browser tests] no Chrome/Chromium found (set CHROME_PATH): skipped');

/** Startup and teardown can take well over 20 s on a loaded machine (seen during a full `npm test` on Windows). */
export const LIFECYCLE_TIMEOUT_MS = 60_000;

export interface BrowserEnv {
  readonly server: ViteDevServer;
  readonly browser: Browser;
  /** The dev server's base URL, with a trailing slash. */
  readonly base: string;
}

export async function startBrowserEnv(): Promise<BrowserEnv> {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    server: { port: 0, strictPort: false },
    logLevel: 'error',
  });
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0]!;
    const browser = await chromium.launch({ executablePath: executablePath! });
    return { server, browser, base };
  } catch (e) {
    await server.close();
    throw e;
  }
}

export async function stopBrowserEnv(env: BrowserEnv | undefined): Promise<void> {
  if (!env) return;
  await Promise.allSettled([env.browser.close(), env.server.close()]);
}

/** A phone: touch, mobile viewport semantics (meta viewport honoured), a high-density screen. */
export function phoneContext(width: number, height: number): BrowserContextOptions {
  return { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
}

/** Runs `fn` on a fresh page in its own context; the context is always closed, even on failure. */
export async function withPage<T>(env: BrowserEnv, options: BrowserContextOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  let context: BrowserContext | null = null;
  try {
    context = await env.browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // A cold dev server transforms the app on the first visit: navigations get longer.
    page.setDefaultNavigationTimeout(20_000);
    return await fn(page);
  } finally {
    await context?.close().catch(() => {});
  }
}

export interface Fixture {
  ready: boolean;
  emitted: { event: string; payload: unknown }[];
}

/** Opens the table fixture (`tests/browser/fixtures/table.html`) and waits until it delivered its states. */
export async function openFixture(page: Page, base: string, scenario?: string): Promise<void> {
  await page.goto(`${base}tests/browser/fixtures/table.html${scenario ? `?scenario=${scenario}` : ''}`);
  await page.waitForFunction(() => (window as unknown as { __fixture?: Fixture }).__fixture?.ready === true);
}

export async function emittedEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __fixture: Fixture }).__fixture.emitted.map((e) => e.event));
}

/**
 * Every visible button/link/input whose center point is covered by something that isn't itself or
 * its content. `skip`: controls checked another way (overlapping hand cards: their visible slice).
 */
export async function coveredControls(page: Page, skip?: string): Promise<string[]> {
  return page.evaluate((skip) => {
    const covered: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, [role="radio"], [role="switch"]')) {
      if (skip && el.matches(skip)) continue;
      // sr-only inputs (styled switches) are clicked through their label.
      const target = el.matches('input.sr-only') ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (y < 0 || y > window.innerHeight) continue; // off screen: a scroll away, not covered
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(target === hit || target.contains(hit) || (el instanceof HTMLInputElement && el.labels?.[0]?.contains(hit)))) {
        covered.push(`${el.outerHTML.slice(0, 80)} covered by ${hit?.outerHTML.slice(0, 80) ?? 'nothing'}`);
      }
    }
    return covered;
  }, skip);
}
