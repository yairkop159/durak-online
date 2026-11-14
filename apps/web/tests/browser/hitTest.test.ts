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
import { type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t } from '../../src/i18n';
import { LIFECYCLE_TIMEOUT_MS, coveredControls, executablePath, seedProfile, startBrowserEnv, stopBrowserEnv, stubProfileApi, type BrowserEnv } from './harness';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** Screens the crowded table must fit without scrolling (SCREENSHOT_DIR=<dir> saves a screenshot of each). */
const FIT_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  // A phone on its side: the "short" layout (seats in one row, my seat and Take beside the hand).
  { width: 740, height: 360 },
] as const;

describe.skipIf(!executablePath)('real browser: controls are clickable', () => {
  let env: BrowserEnv | undefined;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    env = await startBrowserEnv();
    ({ browser, base } = env);
  }, LIFECYCLE_TIMEOUT_MS);

  afterAll(() => stopBrowserEnv(env), LIFECYCLE_TIMEOUT_MS);

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

    it(`table (${vp.name}): a moment banner and reaction bubbles never block the hand, the table or Take/Pass`, async () => {
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
            // Attack cards I can defend against are click targets too (the moment banner floats over them).
            ...document.querySelectorAll<HTMLElement>('[data-testid="table"] button'),
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

    for (const path of ['/', '/rules', '/profile', '/leaderboard']) {
      it(`${path} (${vp.name}): no visible control is covered by another element`, async () => {
        const page = await browser.newPage({ viewport: vp });
        try {
          await seedProfile(page);
          await stubProfileApi(page);
          await page.goto(base + path.slice(1));
          if (path === '/profile') await page.getByTestId('rating').waitFor({ timeout: 15_000 });
          if (path === '/leaderboard') await page.locator('ol[aria-label] > li').first().waitFor({ timeout: 15_000 });
          await page.getByRole('heading', { level: 1 }).first().waitFor();
          expect(await coveredControls(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  // The table screen fits one viewport: however full the table and the hand, nothing scrolls.
  for (const vp of FIT_VIEWPORTS) {
    it(`table ${vp.width}x${vp.height}: 6 pairs + a 15-card hand fit the screen, every card and Take clickable`, async () => {
      const page = await browser.newPage({ viewport: vp });
      try {
        await page.goto(`${base}tests/browser/fixtures/table.html?scenario=crowded`);
        await page.waitForFunction(() => (window as unknown as { __fixture?: { ready: boolean } }).__fixture?.ready === true);
        await page.getByTestId('moment-banner').waitFor({ state: 'visible', timeout: 3000 });
        await page.getByTestId('reaction-bubble-me').waitFor({ state: 'visible' });
        await page.getByRole('button', { name: t.table.take }).waitFor();
        // Let the cards' layout springs settle before measuring.
        await page.waitForTimeout(700);
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/table-${vp.width}x${vp.height}.png` });

        const result = await page.evaluate(() => {
          const OVERLAYS = '[data-testid^="reaction-bubble"], [data-testid="moment-banner"], [data-testid="seat-effect"]';
          const doc = document.scrollingElement!;
          const W = window.innerWidth;
          const H = window.innerHeight;
          const inside = (r: DOMRect) => r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H;
          const problems: string[] = [];
          if (doc.scrollHeight > H || doc.scrollWidth > W) problems.push(`document scrolls: ${doc.scrollWidth}x${doc.scrollHeight}`);
          const label = (el: Element) => el.getAttribute('data-card') ?? el.textContent ?? el.tagName;

          const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="hand"] [data-card]')];
          const clickAt: Record<string, { x: number; y: number }> = {};
          for (const el of cards) {
            const r = el.getBoundingClientRect();
            if (!inside(r)) problems.push(`hand card ${label(el)} outside the viewport: ${JSON.stringify(r)}`);
            // Some point of the card (its visible slice: the next card covers the rest) is the card itself.
            let point: { x: number; y: number } | null = null;
            for (let i = 1; i < 20 && !point; i += 2) {
              for (const j of [3, 5, 7]) {
                const x = r.left + (r.width * i) / 20;
                const y = r.top + (r.height * j) / 10;
                const hit = document.elementFromPoint(x, y);
                if (hit && el.contains(hit) && !hit.closest(OVERLAYS)) {
                  point = { x, y };
                  break;
                }
              }
            }
            if (point) clickAt[el.getAttribute('data-card')!] = point;
            else problems.push(`hand card ${label(el)} has no clickable point`);
          }
          const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid="action-row"] button')];
          for (const el of buttons) {
            const r = el.getBoundingClientRect();
            if (!inside(r)) problems.push(`button ${label(el)} outside the viewport`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !el.contains(hit)) problems.push(`button ${label(el)} covered by ${hit?.outerHTML.slice(0, 80)}`);
          }
          for (const el of document.querySelectorAll<HTMLElement>('[data-testid="table"] [data-card]')) {
            if (!inside(el.getBoundingClientRect())) problems.push(`table card ${label(el)} outside the viewport`);
          }
          return {
            problems,
            clickAt,
            handCount: cards.length,
            pairs: document.querySelectorAll('[data-testid^="pair-"]').length,
            buttons: buttons.length,
          };
        });
        expect(result.problems).toEqual([]);
        expect(result.handCount).toBe(15);
        expect(result.pairs).toBe(6);
        expect(result.buttons).toBeGreaterThan(0);
        expect(await coveredControls(page, '[data-testid="hand"] [data-card]')).toEqual([]);

        // Raw mouse clicks on the visible slices: playable cards at both ends of the clubs/hearts run.
        for (const id of ['8C', 'JH']) {
          const card = page.locator(`[data-testid="hand"] [data-card="${id}"]`);
          expect(await card.count(), `hand card ${id}`).toBe(1);
          const p = result.clickAt[id]!;
          await page.mouse.click(p.x, p.y);
          await expect(card.getAttribute('data-state')).resolves.toBe('selected');
        }
        const take = (await page.getByRole('button', { name: t.table.take }).boundingBox())!;
        await page.mouse.click(take.x + take.width / 2, take.y + take.height / 2);
        const emitted = await page.evaluate(
          () => (window as unknown as { __fixture: { emitted: { event: string }[] } }).__fixture.emitted.map((e) => e.event),
        );
        expect(emitted).toContain('game:move');
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
