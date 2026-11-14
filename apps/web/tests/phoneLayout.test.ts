import { describe, expect, it } from 'vitest';
import { layoutModeFor } from '../src/layout/layoutMode';
import { fitOverlap, MIN_VISIBLE_SLICE } from '../src/screens/table/HandFan';
import { fitTableCardWidth, naturalTableCardWidth, PAIRS_PER_ROW } from '../src/screens/table/TableSurface';

describe('layout mode', () => {
  it.each([
    [360, 740, 'phone'],
    [390, 844, 'phone'],
    [740, 360, 'short'],
    [844, 390, 'short'],
    // Bigger phones on their side, installed and in Safari (its toolbars take height).
    [932, 430, 'short'],
    [844, 320, 'short'],
    [932, 360, 'short'],
    [1280, 720, 'regular'],
    [768, 1024, 'regular'],
    // A tiny portrait window is still a phone, not "short".
    [320, 480, 'phone'],
  ] as const)('%ix%i is %s', (w, h, mode) => {
    expect(layoutModeFor(w, h)).toBe(mode);
  });
});

describe('table card fitting', () => {
  it('phones get bigger natural table cards than before (72 px, was 54)', () => {
    expect(naturalTableCardWidth(360)).toBe(72);
    expect(naturalTableCardWidth(1280)).toBeGreaterThanOrEqual(64);
  });

  it('never grows past the natural width', () => {
    expect(fitTableCardWidth(1, 2000, 2000, 72)).toEqual({ width: 72, columns: 1 });
  });

  it('a tall phone table keeps 3 pairs per row (6 pairs = 2 rows)', () => {
    // 360x740 portrait: the table box is about 328 x 240.
    const fit = fitTableCardWidth(6, 328, 240, 72);
    expect(fit.columns).toBe(PAIRS_PER_ROW);
    expect(fit.width).toBeGreaterThanOrEqual(55);
  });

  it('a wide, short table lays 6 pairs in one row when that makes the cards bigger', () => {
    // 740x360 landscape: the table box is about 560 x 110.
    const fit = fitTableCardWidth(6, 560, 110, 90);
    expect(fit.columns).toBe(6);
    const threePerRow = Math.floor(Math.min(560 / (3 * 1.25 + 2 * 0.3), 110 / ((2 * 1.28 + 0.12) * (78 / 54))));
    expect(fit.width).toBeGreaterThan(threePerRow);
  });

  it('prefers the fewest columns on a tie (a capped desktop table keeps 3 per row)', () => {
    expect(fitTableCardWidth(6, 1000, 700, 90).columns).toBe(3);
  });

  it('never below the minimum, never more columns than items', () => {
    const fit = fitTableCardWidth(7, 50, 50, 72);
    expect(fit.width).toBe(28);
    expect(fitTableCardWidth(2, 2000, 100, 90).columns).toBeLessThanOrEqual(2);
  });
});

describe('hand overlap', () => {
  it('compresses a 15-card hand into a phone width, keeping a visible slice of every card', () => {
    const cardW = 60;
    const avail = 344;
    const overlap = fitOverlap(15, cardW, avail, 30);
    expect(cardW + 14 * (cardW - overlap)).toBeLessThanOrEqual(avail);
    expect(cardW - overlap).toBeGreaterThanOrEqual(MIN_VISIBLE_SLICE);
  });

  it('keeps the fan overlap when the hand fits', () => {
    expect(fitOverlap(6, 60, 344, 16)).toBe(16);
  });
});
