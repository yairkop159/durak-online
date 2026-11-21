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

/** Chrome's error when the OS reports a network change mid-request (see `withPage`). */
const NETWORK_CHANGED = 'net::ERR_NETWORK_CHANGED';

/**
 * Runs `fn` on a fresh page in its own context; the context is always closed, even on failure.
 *
 * Retried once, on a new context, ONLY when the attempt failed and Chrome aborted a request with
 * ERR_NETWORK_CHANGED during it. On Windows, Docker Desktop's virtual adapters can flap; Chrome
 * then aborts in-flight requests, a Vite module load fails, the app never mounts, and no wait is
 * long enough (seen: 1 of 140 page loads). Any other failure is rethrown as is.
 */
export async function withPage<T>(env: BrowserEnv, options: BrowserContextOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const first = await attempt(env, options, fn);
  if (first.ok) return first.value;
  if (!first.networkChanged) throw first.error;
  console.warn(`[browser tests] retried: network changed (${first.networkChanged})`);
  const second = await attempt(env, options, fn);
  if (second.ok) return second.value;
  throw second.error;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown; networkChanged: string | null };

async function attempt<T>(env: BrowserEnv, options: BrowserContextOptions, fn: (page: Page) => Promise<T>): Promise<Attempt<T>> {
  let context: BrowserContext | null = null;
  let networkChanged: string | null = null;
  try {
    context = await env.browser.newContext(options);
    context.on('requestfailed', (request) => {
      if (request.failure()?.errorText === NETWORK_CHANGED) networkChanged ??= request.url();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // A cold dev server transforms the app on the first visit: navigations get longer.
    page.setDefaultNavigationTimeout(20_000);
    return { ok: true, value: await fn(page) };
  } catch (error) {
    return { ok: false, error, networkChanged };
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

/** The device profile the stubbed /api knows (seeded into localStorage by `seedProfile`). */
export const STUB_PROFILE = { v: 1, profileId: 'p'.repeat(22), deviceKey: 'k'.repeat(43), nickname: 'דנה' } as const;

/** Seeds this device's profile before any page script runs. */
export async function seedProfile(page: Page): Promise<void> {
  await page.addInitScript((profile) => {
    try {
      window.localStorage.setItem('durak:profile', JSON.stringify(profile));
    } catch {
      // storage blocked: the page then shows "no profile"
    }
  }, STUB_PROFILE);
}

/**
 * Answers every /api call (any host: the dev client talks to localhost:3000) with fixed data, so
 * the profile and leaderboard pages render full: long nicknames, 20 recent games, 20 rows.
 */
export async function stubProfileApi(page: Page): Promise<void> {
  const me = STUB_PROFILE.profileId;
  const long = 'שם ארוך מאוד של שחקן';
  const recent = Array.from({ length: 20 }, (_, i) => ({
    gameId: `g${i}`,
    endedAt: Date.UTC(2026, 10, 14) - i * 3_600_000,
    mode: i % 2 ? 'perevodnoy' : 'podkidnoy',
    endReason: 'normal',
    rated: i % 3 !== 0,
    result: (['win', 'durak', 'draw', 'forfeit', 'unfinished'] as const)[i % 5],
    ratingBefore: i % 3 !== 0 ? 1000 : null,
    ratingAfter: i % 3 !== 0 ? (i % 2 ? 984 : 1016) : null,
    botAssisted: i % 4 === 0,
    others: [
      { nickname: long, isBot: false, profileId: 'o'.repeat(22), result: 'durak' },
      { nickname: 'Bot 1', isBot: true, profileId: null, result: 'win' },
      { nickname: 'אבי', isBot: false, profileId: null, result: 'win' },
    ],
  }));
  const profile = { profileId: me, nickname: STUB_PROFILE.nickname, rating: 1234, games: 57, ratedGames: 40, wins: 31, duraks: 12, forfeits: 1, tournamentsWon: 2, rank: 3, recent };
  const entries = Array.from({ length: 20 }, (_, i) => ({
    rank: i + 1,
    profileId: i === 2 ? me : `${String(i).padStart(2, '0')}`.padEnd(22, 'x'),
    nickname: i === 2 ? STUB_PROFILE.nickname : i % 3 === 0 ? `${long} ${i}` : `שחקן ${i}`,
    rating: 1400 - i * 9,
    ratedGames: 120 - i,
    wins: 80 - i,
    duraks: 10 + i,
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, PATCH',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (path === '/profile/me') return json(200, { profileId: me, nickname: STUB_PROFILE.nickname });
    if (path === '/leaderboard') return json(200, { entries });
    if (path === '/profile/transfer-code') return json(200, { code: 'ABCD1234', expiresAt: 1_000 + 600_000, serverTime: 1_000 });
    if (path.startsWith('/profile/')) return json(200, { ...profile, profileId: path.slice('/profile/'.length) });
    return json(404, { error: 'NOT_FOUND' });
  });
}
