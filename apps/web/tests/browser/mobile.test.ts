// @vitest-environment node
/**
 * Phones, emulated in a real Chrome (touch, mobile viewport, 3x density) at 360x740 and 390x844, and
 * on their side at 740x360, 844x390 and 932x430 (installed, full height) and 844x320 and 932x360
 * (an iPhone in Safari: the toolbars take height). For Home, the rules (both tabs), the settings dialog, the lobby,
 * a crowded six-player table and the game-over screen:
 * - no horizontal scroll anywhere (the table: no scroll at all);
 * - every control fully visible (scrolled into view where the page scrolls), at least 44x44 px
 *   (hand cards: a visible slice of at least 16 px, their height is the target) and the topmost
 *   element at its center;
 * - real taps work: a hand card, a defense on the table, Take, the settings gear;
 * - the PWA basics are in place (manifest, icons, viewport-fit=cover, no double-tap zoom).
 *
 * Every test has a hard timeout and closes its browser context in `finally` (withPage); startup and
 * teardown are bounded too, so a stuck browser can never hang the run.
 */
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t } from '../../src/i18n';
import {
  LIFECYCLE_TIMEOUT_MS,
  coveredControls,
  emittedEvents,
  executablePath,
  openFixture,
  phoneContext,
  seedProfile,
  startBrowserEnv,
  stubProfileApi,
  stopBrowserEnv,
  withPage,
  type BrowserEnv,
} from './harness';

/** Phones on their side: installed / full height, and in Safari with its toolbars (about 844x320, 932x360). */
const LANDSCAPE = [
  { width: 740, height: 360 },
  { width: 844, height: 390 },
  { width: 932, height: 430 },
  { width: 844, height: 320 },
  { width: 932, height: 360 },
] as const;
const PHONES = [{ width: 360, height: 740 }, { width: 390, height: 844 }, ...LANDSCAPE] as const;
/** A notch / Dynamic Island in landscape: the safe-area inset on the left or the right (iPhone: 47-59 px). */
const NOTCH = 47;

const TEST_TIMEOUT_MS = 45_000;
const MIN_TARGET = 44;
const MIN_SLICE = 16;
const HAND_CARD = '[data-testid="hand"] [data-card]';

interface Audit {
  problems: string[];
  controls: number;
}

/**
 * The page-wide checks. `fit`: the page must not scroll at all (the table). `skip`: controls
 * checked another way (overlapping hand cards).
 */
async function audit(page: Page, fit: boolean, skip?: string): Promise<Audit> {
  return page.evaluate(
    ({ fit, skip, MIN_TARGET }) => {
      const problems: string[] = [];
      const W = window.innerWidth;
      const H = window.innerHeight;
      const doc = document.scrollingElement!;
      const scrollProblem = () => {
        if (doc.scrollWidth > W) problems.push(`horizontal scroll: ${doc.scrollWidth} > ${W}`);
        if (fit && doc.scrollHeight > H) problems.push(`the page scrolls: ${doc.scrollHeight} > ${H}`);
      };
      scrollProblem();
      // ...also with the page scrolled to the bottom (lazy content, sticky footers).
      window.scrollTo(0, doc.scrollHeight);
      scrollProblem();
      window.scrollTo(0, 0);

      const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
      // An open modal dialog is all that can be used: what's behind it is meant to be unreachable.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      const scope: ParentNode = modals.length > 0 ? modals[modals.length - 1]! : document;
      const controls = [...scope.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="switch"], [role="radio"], [role="tab"]')]
        .filter((el) => !(skip && el.matches(skip)))
        // Styled switches (an sr-only input) and radios/checkboxes inside a label: the label is
        // what a finger hits (tapping anywhere on it toggles the input).
        .map((el) => (el.matches('input.sr-only, label input[type="radio"], label input[type="checkbox"]') ? (el.closest('label') ?? el) : el))
        .filter((el, i, all) => all.indexOf(el) === i)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && !el.closest('[inert], [aria-hidden="true"]');
        });
      for (const el of controls) {
        if (!fit) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) {
          problems.push(`${label(el)} not fully on screen: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          continue;
        }
        if (r.width < MIN_TARGET - 0.5 || r.height < MIN_TARGET - 0.5) {
          problems.push(`${label(el)} is ${Math.round(r.width)}x${Math.round(r.height)} (< ${MIN_TARGET})`);
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const input = el.querySelector('input');
        if (!hit || !(el === hit || el.contains(hit) || (input?.labels?.[0]?.contains(hit) ?? false))) {
          problems.push(`${label(el)} covered by ${hit?.outerHTML.slice(0, 70) ?? 'nothing'}`);
        }
      }
      window.scrollTo(0, 0);
      return { problems, controls: controls.length };
    },
    { fit, skip, MIN_TARGET },
  );
}

/**
 * Rating parts of the game-over panel: each one, scrolled into view inside the panel, is fully inside
 * the viewport, not wider than it, and not hidden under the sticky actions (the topmost element at
 * its centre belongs to it).
 */
async function ratingVisibility(page: Page, ...testIds: string[]): Promise<string[]> {
  return page.evaluate((ids) => {
    const problems: string[] = [];
    for (const id of ids) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!el) {
        problems.push(`${id} missing`);
        continue;
      }
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.top < -0.5 || r.bottom > window.innerHeight + 0.5) {
        problems.push(`${id} not fully on screen: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !el.contains(hit)) problems.push(`${id} covered by ${hit?.outerHTML.slice(0, 70) ?? 'nothing'}`);
    }
    return problems;
  }, testIds);
}

/** Each hand card: inside the viewport, a visible slice >= MIN_SLICE wide, and a tap point on it. */
async function handSlices(page: Page): Promise<{ problems: string[]; tapAt: Record<string, { x: number; y: number }>; count: number }> {
  return page.evaluate(
    ({ HAND_CARD, MIN_SLICE }) => {
      const problems: string[] = [];
      const tapAt: Record<string, { x: number; y: number }> = {};
      const cards = [...document.querySelectorAll<HTMLElement>(HAND_CARD)];
      for (const el of cards) {
        const id = el.getAttribute('data-card')!;
        const r = el.getBoundingClientRect();
        if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) problems.push(`${id} off screen`);
        // Columns (1 px apart) at mid-height where this card is the topmost element.
        const y = r.top + r.height * 0.45;
        const xs: number[] = [];
        for (let x = Math.ceil(r.left); x <= r.right; x++) {
          const hit = document.elementFromPoint(x, y);
          if (hit && el.contains(hit)) xs.push(x);
        }
        if (xs.length < MIN_SLICE) problems.push(`${id}: visible slice ${xs.length} px (< ${MIN_SLICE})`);
        if (xs.length > 0) tapAt[id] = { x: xs[Math.floor(xs.length / 2)]!, y };
      }
      return { problems, tapAt, count: cards.length };
    },
    { HAND_CARD, MIN_SLICE },
  );
}

async function tapCenter(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** Simulates a notch: sets the --sai-* variable every layout reads (emulation reports zero insets). */
async function simulateInset(page: Page, side: 'left' | 'right', px: number): Promise<void> {
  await page.evaluate(({ side, px }) => document.documentElement.style.setProperty(`--sai-${side}`, `${px}px`), { side, px });
}

/** Controls, seats and cards that reach into the inset strip on `side`. */
async function insideInset(page: Page, side: 'left' | 'right', px: number): Promise<string[]> {
  return page.evaluate(
    ({ side, px }) => {
      const W = window.innerWidth;
      const found: string[] = [];
      const selector = 'button, a[href], input, [role="switch"], [role="radio"], [data-testid^="seat-"], [data-card]';
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (el.closest('[data-testid="flights"], [aria-hidden="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const inside = side === 'left' ? r.left < px - 0.5 : r.right > W - px + 0.5;
        if (inside) {
          const name = el.getAttribute('data-testid') ?? el.getAttribute('data-card') ?? (el.textContent ?? '').trim().slice(0, 20);
          found.push(`${name} at ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
      }
      return found;
    },
    { side, px },
  );
}

const OPPONENTS = ['bob', 'carl', 'dana', 'eli', 'fay'];

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/mobile-${name}.png` });
};

describe.skipIf(!executablePath)('phones (mobile emulation, touch)', () => {
  let env: BrowserEnv | undefined;

  beforeAll(async () => {
    env = await startBrowserEnv();
  }, LIFECYCLE_TIMEOUT_MS);

  afterAll(() => stopBrowserEnv(env), LIFECYCLE_TIMEOUT_MS);

  for (const vp of PHONES) {
    const size = `${vp.width}x${vp.height}`;

    it(`Home ${size}: no horizontal scroll, every control visible, >= 44 px and tappable; the gear opens settings by tap`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await page.goto(env!.base);
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        const home = await audit(page, false);
        expect(home.problems).toEqual([]);
        expect(home.controls).toBeGreaterThan(3);
        await shot(page, `home-${size}`);

        await tapCenter(page, `button[aria-label="${t.settings.title}"]`);
        const dialog = page.getByRole('dialog', { name: t.settings.title });
        await dialog.waitFor();
        await page.waitForTimeout(300);
        const settings = await audit(page, false);
        expect(settings.problems).toEqual([]);
        expect(settings.controls).toBeGreaterThan(5);
        await shot(page, `settings-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`rules ${size}: both tabs, no horizontal scroll, controls >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await page.goto(`${env!.base}rules`);
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        expect((await audit(page, false)).problems).toEqual([]);
        await tapCenter(page, '#tab-guide');
        await page.waitForFunction(() => document.querySelector('#tab-guide')?.getAttribute('aria-selected') === 'true');
        expect((await audit(page, false)).problems).toEqual([]);
        await shot(page, `rules-guide-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`profile ${size}: stats, 20 recent games, transfer code; no horizontal scroll, controls >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await seedProfile(page);
        await stubProfileApi(page);
        await page.goto(`${env!.base}profile`);
        // The stubbed /api answers in well under 1 s after the page loaded (measured over 140 loads).
        await page.getByTestId('rating').waitFor();
        expect(await page.getByTestId('recent-game').count()).toBe(20);
        const before = await audit(page, false);
        expect(before.problems).toEqual([]);
        expect(before.controls).toBeGreaterThan(4);
        // Below the fold on a phone: scroll it into view, then a real touch tap at its center.
        const transfer = `button:has-text("${t.profile.transfer.button}")`;
        await page.locator(transfer).scrollIntoViewIfNeeded();
        await tapCenter(page, transfer);
        await page.getByTestId('transfer-code').waitFor();
        expect((await audit(page, false)).problems).toEqual([]);
        await shot(page, `profile-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`leaderboard ${size}: 20 rows, mine highlighted; no horizontal scroll, rows >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await seedProfile(page);
        await stubProfileApi(page);
        await page.goto(`${env!.base}leaderboard`);
        await page.getByRole('list', { name: t.leaderboard.title }).waitFor();
        expect(await page.locator('ol[aria-label] > li').count()).toBe(20);
        expect(await page.locator('[aria-current="true"]').count()).toBe(1);
        const board = await audit(page, false);
        expect(board.problems).toEqual([]);
        expect(board.controls).toBeGreaterThan(20);
        await shot(page, `leaderboard-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`lobby ${size}: no horizontal scroll, controls >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base, 'lobby');
        await page.getByRole('button', { name: t.bots.remove(t.bots.name('b1')) }).first().waitFor({ state: 'attached' }).catch(() => {});
        await page.waitForTimeout(300);
        const lobby = await audit(page, false);
        expect(lobby.problems).toEqual([]);
        expect(lobby.controls).toBeGreaterThan(2);
        await shot(page, `lobby-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`crowded six-player table ${size}: fits the screen, every control visible and tappable; tap to defend, tap Take`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base, 'crowded6');
        await page.getByTestId('moment-banner').waitFor({ state: 'visible', timeout: 3000 });
        await page.getByRole('button', { name: t.table.take }).waitFor();
        await page.waitForTimeout(700); // the cards' layout springs settle
        await shot(page, `table-${size}`);

        const table = await audit(page, true, HAND_CARD);
        expect(table.problems).toEqual([]);
        expect(await coveredControls(page, HAND_CARD)).toEqual([]);
        // All five opponents are on screen.
        for (const id of ['bob', 'carl', 'dana', 'eli', 'fay']) {
          const box = await page.getByTestId(`seat-${id}`).boundingBox();
          expect(box, id).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
        }

        const hand = await handSlices(page);
        expect(hand.problems).toEqual([]);
        expect(hand.count).toBe(15);
        expect(await page.locator('[data-testid^="pair-"]').count()).toBe(6);

        // Tap a hand card, then the uncovered 7♣ on the table: a defense goes out.
        await page.touchscreen.tap(hand.tapAt['8C']!.x, hand.tapAt['8C']!.y);
        await expect(page.locator(`${HAND_CARD}[data-card="8C"]`).getAttribute('data-state')).resolves.toBe('selected');
        const target = page.locator('[data-testid="pair-3"] [data-card="7C"]');
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(() =>
          (window as unknown as { __fixture: { emitted: { event: string; payload: { move?: { type: string } } }[] } }).__fixture.emitted.some(
            (e) => e.event === 'game:move' && e.payload.move?.type === 'defend',
          ),
        );

        // Take, by tap.
        const before = (await emittedEvents(page)).filter((e) => e === 'game:move').length;
        await tapCenter(page, `button:text-is("${t.table.take}")`);
        await page.waitForFunction(
          (n) => (window as unknown as { __fixture: { emitted: { event: string }[] } }).__fixture.emitted.filter((e) => e.event === 'game:move').length > n,
          before,
        );
      });
    }, TEST_TIMEOUT_MS);

    it(`game over ${size}: no horizontal scroll; the stats, the reaction button and "back to lobby" reachable and >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base, 'gameover');
        await page.getByTestId('game-over-headline').waitFor();
        await page.waitForTimeout(800); // the panel's spring
        // Open the full stats table (the widest thing on the screen).
        const showAll = page.locator(`button:text-is("${t.stats.showAll}")`);
        await showAll.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await tapCenter(page, `button:text-is("${t.stats.showAll}")`);
        await page.getByTestId('stats-table').waitFor();
        // The others' rating changes are a column of the open table (no extra list).
        expect(await page.getByTestId('stats-rating-bob').textContent()).toBe('+6');
        expect(await page.getByTestId('rating-others').count()).toBe(0);
        const over = await audit(page, true);
        expect(over.problems).toEqual([]);
        // The main action is on screen without scrolling (the actions stay pinned to the panel's bottom).
        const back = (await page.getByRole('button', { name: t.gameOver.backToLobby }).boundingBox())!;
        expect(back.y + back.height).toBeLessThanOrEqual(vp.height);
        expect(back.y).toBeGreaterThanOrEqual(0);
        expect(await ratingVisibility(page, 'rating-delta')).toEqual([]);
        await shot(page, `gameover-${size}`);
      });
    }, TEST_TIMEOUT_MS);

    it(`game over after a reload ${size}: my rating change and the others' list fit; nothing scrolls sideways; controls >= 44 px`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base, 'gameover-reload');
        await page.getByTestId('game-over-headline').waitFor();
        await page.waitForTimeout(800); // the panel's spring
        expect(await page.getByTestId('stats-table').count()).toBe(0); // no game:over after a reload
        expect((await page.getByTestId('rating-delta').textContent())!).toContain('−32');
        expect(await page.getByTestId('rating-others').locator('li').count()).toBe(5);
        // My change is on screen as the overlay opens, without scrolling the panel.
        const mine = (await page.getByTestId('rating-delta').boundingBox())!;
        expect(mine.y).toBeGreaterThanOrEqual(0);
        expect(mine.y + mine.height).toBeLessThanOrEqual(vp.height);
        const over = await audit(page, true);
        expect(over.problems).toEqual([]);
        const back = (await page.getByRole('button', { name: t.gameOver.backToLobby }).boundingBox())!;
        expect(back.y).toBeGreaterThanOrEqual(0);
        expect(back.y + back.height).toBeLessThanOrEqual(vp.height);
        expect(await ratingVisibility(page, 'rating-delta', 'rating-others')).toEqual([]);
        await shot(page, `gameover-reload-${size}`);
      });
    }, TEST_TIMEOUT_MS);
  }

  for (const vp of LANDSCAPE) {
    const size = `${vp.width}x${vp.height}`;

    it(`landscape ${size}: three columns (seats right, my controls left, in RTL); the table and the hand use the space`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base, 'crowded6');
        await page.getByRole('button', { name: t.table.take }).waitFor();
        await page.waitForTimeout(700);
        expect(await page.locator('[data-layout]').getAttribute('data-layout')).toBe('short');
        expect(await page.locator('[data-layout]').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');

        // RTL: the seat column is on the right of the table (where reading starts), Take and the piles on its left.
        const table = await boxOf(page, '[data-testid="table-surface"]');
        for (const id of OPPONENTS) {
          const seat = await boxOf(page, `[data-testid="seat-${id}"]`);
          expect(seat.x, id).toBeGreaterThanOrEqual(table.x + table.w);
          expect(seat.x + seat.w, id).toBeLessThanOrEqual(vp.width);
          expect(seat.y + seat.h, id).toBeLessThanOrEqual(vp.height);
        }
        const take = await boxOf(page, `button:text-is("${t.table.take}")`);
        expect(take.x + take.w).toBeLessThanOrEqual(table.x);
        const piles = await boxOf(page, '[data-testid="piles"]');
        expect(piles.x + piles.w).toBeLessThanOrEqual(table.x);

        // The space: hand cards about 30% of the height, at most 14vw (they were 86-96 px tall at every size before),
        // and even six pairs on the table stay at least 50 px wide.
        const hand = await boxOf(page, `${HAND_CARD}[data-card="8C"]`);
        expect(hand.h).toBeGreaterThanOrEqual(Math.min(106, 0.29 * vp.height, 0.139 * vp.width));
        const tableCard = await boxOf(page, '[data-testid="pair-0"] [data-card="6S"]');
        expect(tableCard.w).toBeGreaterThanOrEqual(50);
      });
    }, TEST_TIMEOUT_MS);

    it(`landscape ${size}: a small table gets big cards (they were 51 px wide below 400 px of height)`, async () => {
      await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
        await openFixture(page, env!.base);
        await page.getByRole('button', { name: t.table.take }).waitFor();
        await page.waitForTimeout(700);
        const tableCard = await boxOf(page, '[data-testid="pair-0"] [data-card="6S"]');
        expect(tableCard.w).toBeGreaterThanOrEqual(62);
      });
    }, TEST_TIMEOUT_MS);

    for (const side of ['left', 'right'] as const) {
      it(`landscape ${size}, notch on the ${side} (${NOTCH} px inset): nothing inside the inset; still fits, every control tappable`, async () => {
        await withPage(env!, phoneContext(vp.width, vp.height), async (page) => {
          await openFixture(page, env!.base, 'crowded6');
          await page.getByRole('button', { name: t.table.take }).waitFor();
          await simulateInset(page, side, NOTCH);
          await page.waitForTimeout(700);
          await shot(page, `notch-${side}-${size}`);
          expect(await insideInset(page, side, NOTCH)).toEqual([]);
          const table = await audit(page, true, HAND_CARD);
          expect(table.problems).toEqual([]);
          expect((await handSlices(page)).problems).toEqual([]);
          for (const id of OPPONENTS) await expect(page.getByTestId(`seat-${id}`).isVisible()).resolves.toBe(true);
        });
      }, TEST_TIMEOUT_MS);
    }
  }

  it('rotation mid-game: 390x844 -> 844x390 -> 390x844 -> 844x390; fits each time, no errors, flights still find their anchors', async () => {
    await withPage(env!, phoneContext(390, 844), async (page) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        // The fixture page has no icon link: Chrome's automatic /favicon.ico 404 isn't the app's.
        if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) errors.push(m.text());
      });
      await openFixture(page, env!.base, 'crowded6');
      await page.getByRole('button', { name: t.table.take }).waitFor();
      const check = async (mode: string, w: number) => {
        await page.waitForTimeout(700);
        expect(await page.locator('[data-layout]').getAttribute('data-layout')).toBe(mode);
        expect((await audit(page, true, HAND_CARD)).problems).toEqual([]);
        expect(await coveredControls(page, HAND_CARD)).toEqual([]);
        const hand = await handSlices(page);
        expect(hand.problems).toEqual([]);
        expect(hand.count).toBe(15);
        for (const id of OPPONENTS) {
          const seat = await boxOf(page, `[data-testid="seat-${id}"]`);
          expect(seat.x + seat.w, id).toBeLessThanOrEqual(w);
        }
      };
      await check('phone', 390);
      await page.setViewportSize({ width: 844, height: 390 });
      await check('short', 844);
      await page.setViewportSize({ width: 390, height: 844 });
      await check('phone', 390);
      await page.setViewportSize({ width: 844, height: 390 });
      await check('short', 844);

      // The bout ends (beaten): the table cards fly to the discard pile, which moved to the side panel.
      const piles = await boxOf(page, '[data-testid="piles"]');
      await page.evaluate(() => (window as unknown as { __fixture: { advance: () => void } }).__fixture.advance());
      await page.locator('[data-testid="flights"] > div').first().waitFor({ state: 'attached', timeout: 3000 });
      const flights = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="flights"] > div')].map((el) => {
          const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          return [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite);
        }),
      );
      expect(flights.length).toBeGreaterThan(0);
      expect(flights.every(Boolean)).toBe(true);
      // Every flight lands on the discard pile (left, in the side panel): follow them frame by frame
      // until the layer empties, and keep each card's leftmost x.
      const leftmost = await page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const min = new Map<Element, number>();
            const started = performance.now();
            const tick = () => {
              const els = [...document.querySelectorAll<HTMLElement>('[data-testid="flights"] > div')];
              for (const el of els) {
                const x = new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
                min.set(el, Math.min(min.get(el) ?? Infinity, x));
              }
              if (els.length === 0 || performance.now() - started > 4000) resolve([...min.values()]);
              else requestAnimationFrame(tick);
            };
            tick();
          }),
      );
      expect(leftmost.length).toBeGreaterThan(0);
      for (const x of leftmost) expect(x).toBeLessThanOrEqual(piles.x + piles.w);
      await expect(page.locator('[data-testid="flights"]').count()).resolves.toBe(0);
      expect(errors).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('PWA: the manifest and its icons load; viewport-fit=cover; a double tap never zooms', async () => {
    await withPage(env!, phoneContext(390, 844), async (page) => {
      await page.goto(env!.base);
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      const result = await page.evaluate(async () => {
        const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
        const manifest = (await (await fetch(href)).json()) as { display: string; icons: { src: string; sizes: string }[] };
        const icons: string[] = [];
        for (const icon of manifest.icons) {
          const bitmap = await createImageBitmap(await (await fetch(icon.src)).blob());
          icons.push(`${icon.sizes}=${bitmap.width}x${bitmap.height}`);
        }
        return {
          display: manifest.display,
          icons,
          viewport: document.querySelector('meta[name="viewport"]')!.getAttribute('content'),
          touchAction: getComputedStyle(document.documentElement).touchAction,
          userSelect: getComputedStyle(document.body).userSelect,
        };
      });
      expect(result.display).toBe('standalone');
      expect(result.icons.length).toBeGreaterThanOrEqual(3);
      for (const icon of result.icons) {
        const [stated, actual] = icon.split('=');
        expect(actual).toBe(stated);
      }
      expect(result.viewport).toContain('viewport-fit=cover');
      expect(result.touchAction).toBe('manipulation');
      expect(result.userSelect).toBe('none');
    });
  }, TEST_TIMEOUT_MS);
});
