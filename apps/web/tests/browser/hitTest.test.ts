// @vitest-environment node
/**
 * Real-browser layout checks (jsdom has no layout, so it can't see an element painted over a button).
 *
 * Starts the Vite dev server and drives a locally installed Chrome/Chromium/Edge through
 * playwright-core. Without a browser the suite is skipped with a warning (set CHROME_PATH to
 * point at one). Regression: on Home, the decorative suit row (a CSS filter = its own stacking
 * context, painted after the absolutely positioned gear) covered the settings gear, so a real
 * click never reached it while every jsdom test passed.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t } from '../../src/i18n';

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
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) console.warn('[browser tests] no Chrome/Chromium found (set CHROME_PATH): skipped');

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** Every visible button/link/input whose center point is covered by something that isn't itself or its content. */
async function coveredControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const covered: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, [role="radio"], [role="switch"]')) {
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
  });
}

describe.skipIf(!executablePath)('real browser: controls are clickable', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      server: { port: 0, strictPort: false },
      logLevel: 'error',
    });
    await server.listen();
    base = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({ executablePath: executablePath! });
  }, 60_000);

  // Like startup, shutting Chrome and Vite down can take well over 20 s on a loaded machine
  // (seen during a full `npm test` on Windows): same bound as beforeAll.
  afterAll(async () => {
    await Promise.all([browser?.close(), server?.close()]);
  }, 60_000);

  for (const vp of VIEWPORTS) {
    it(`Home (${vp.name}): the settings gear opens the dialog with a real mouse click`, async () => {
      const page = await browser.newPage({ viewport: vp });
      try {
        await page.goto(base);
        const gear = page.getByRole('button', { name: t.settings.title });
        await gear.waitFor();
        const box = (await gear.boundingBox())!;
        // A raw mouse click at the gear's center (no actionability retries), like a user's.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.getByRole('dialog', { name: t.settings.title }).waitFor({ timeout: 2000 })).resolves.toBeUndefined();
      } finally {
        await page.close();
      }
    }, 30_000);

    it(`table (${vp.name}): a moment banner and reaction bubbles never block the hand or Take/Pass`, async () => {
      const page = await browser.newPage({ viewport: vp });
      try {
        await page.goto(`${base}tests/browser/fixtures/table.html`);
        await page.waitForFunction(() => (window as unknown as { __fixture?: { ready: boolean } }).__fixture?.ready === true);
        // The overlays are really on screen right now.
        await page.getByTestId('moment-banner').waitFor({ state: 'visible', timeout: 3000 });
        await page.getByTestId('reaction-bubble-me').waitFor({ state: 'visible' });
        await page.getByTestId('reaction-bubble-carl').waitFor({ state: 'visible' });
        await page.getByTestId('seat-effect').first().waitFor({ state: 'attached' });

        const handCards = page.locator('[data-testid="hand"] [data-card]');
        expect(await handCards.count()).toBe(6);
        const take = page.getByRole('button', { name: t.table.take });
        await take.waitFor();
        const result = await page.evaluate(() => {
          const OVERLAYS = '[data-testid^="reaction-bubble"], [data-testid="moment-banner"], [data-testid="seat-effect"]';
          const targets = [
            ...document.querySelectorAll<HTMLElement>('[data-testid="hand"] [data-card]'),
            ...document.querySelectorAll<HTMLElement>('[data-testid="action-row"] button'),
          ];
          const centers: string[] = [];
          const blocked: string[] = [];
          for (const el of targets) {
            const r = el.getBoundingClientRect();
            // The topmost element at the center is the control itself...
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(el === hit || el.contains(hit))) centers.push(`${el.outerHTML.slice(0, 60)} under ${hit?.outerHTML.slice(0, 80)}`);
            // ...and no point of it, anywhere, lands on an overlay (cards may overlap each other).
            for (let i = 1; i < 10; i += 2) {
              for (let j = 1; j < 10; j += 2) {
                const p = document.elementFromPoint(r.left + (r.width * i) / 10, r.top + (r.height * j) / 10);
                if (p?.closest(OVERLAYS)) blocked.push(`${el.outerHTML.slice(0, 60)} at ${i},${j} under ${p.closest(OVERLAYS)!.outerHTML.slice(0, 60)}`);
              }
            }
          }
          // The check must not be vacuous: some overlay really overlaps some control.
          const overlaps = [...document.querySelectorAll(OVERLAYS)].some((o) => {
            const a = o.getBoundingClientRect();
            return targets.some((t) => {
              const b = t.getBoundingClientRect();
              return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            });
          });
          return { centers, blocked, overlaps };
        });
        expect(result.centers).toEqual([]);
        expect(result.blocked).toEqual([]);
        expect(result.overlaps).toBe(true);
        expect(await coveredControls(page)).toEqual([]);

        // A raw mouse click on a hand card registers (it becomes the selected defense card).
        const first = handCards.first();
        const box = (await first.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(first.getAttribute('data-state')).resolves.toBe('selected');
        // And Take really sends the move.
        const takeBox = (await take.boundingBox())!;
        await page.mouse.click(takeBox.x + takeBox.width / 2, takeBox.y + takeBox.height / 2);
        const emitted = await page.evaluate(
          () => (window as unknown as { __fixture: { emitted: { event: string }[] } }).__fixture.emitted.map((e) => e.event),
        );
        expect(emitted).toContain('game:move');
      } finally {
        await page.close();
      }
    }, 30_000);

    for (const path of ['/', '/rules']) {
      it(`${path} (${vp.name}): no visible control is covered by another element`, async () => {
        const page = await browser.newPage({ viewport: vp });
        try {
          await page.goto(base + path.slice(1));
          await page.getByRole('heading', { level: 1 }).first().waitFor();
          expect(await coveredControls(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
