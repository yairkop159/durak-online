import { describe, expect, it } from 'vitest';
import type { AnimationEvent } from '../src/anim/diffViews';
import { cardStart, scheduleEvents, type TimelineItem } from '../src/anim/timeline';
import { motionTokens as M } from '../src/theme/motion';
import { c, cards } from './helpers';

const played: AnimationEvent = {
  type: 'played',
  by: 'bob',
  from: { kind: 'seat', playerId: 'bob' },
  card: c('7S'),
  kind: 'defend',
  slot: { index: 0, role: 'defense' },
};
const beaten: AnimationEvent = { type: 'beaten', cards: cards('6S 7S') };
const drawn = (player: string, count: number): AnimationEvent => ({
  type: 'drawn',
  player,
  to: { kind: 'seat', playerId: player },
  count,
  cards: null,
  includesTrump: false,
});
const deck: AnimationEvent = { type: 'deck', from: 10, to: 7, trumpGone: false };

const item = (items: readonly TimelineItem[], type: AnimationEvent['type'], nth = 0) =>
  items.filter((i) => i.event.type === type)[nth]!;

describe('scheduleEvents', () => {
  it('a single play starts at once and takes playMs', () => {
    const t = scheduleEvents([played], { reduced: false });
    expect(t.items).toEqual([{ event: played, startMs: 0, durationMs: M.playMs, staggerMs: 0 }]);
    expect(t.totalMs).toBe(M.playMs);
  });

  it('closing play -> resolution -> draws, in that order', () => {
    const t = scheduleEvents([played, beaten, drawn('a', 1), drawn('b', 2), deck], { reduced: false });
    const res = item(t.items, 'beaten');
    expect(res.startMs).toBe(M.playToResolutionMs);
    expect(item(t.items, 'drawn').startMs).toBe(res.startMs + M.resolutionToDrawMs);
    // Draws keep the draw order: b's first card starts after a's card.
    expect(item(t.items, 'drawn', 1).startMs).toBeGreaterThan(item(t.items, 'drawn', 0).startMs);
  });

  it('draws stagger by 120 ms per card when they fit', () => {
    const t = scheduleEvents([beaten, drawn('a', 1), drawn('b', 1)], { reduced: false });
    const [a, b] = [item(t.items, 'drawn', 0), item(t.items, 'drawn', 1)];
    expect(b.startMs - a.startMs).toBe(M.drawStaggerMs);
    expect(a.staggerMs).toBe(M.drawStaggerMs);
  });

  it('many draws compress so the whole resolution stays within the budget', () => {
    const events = [played, { type: 'taken', by: 'x', to: { kind: 'myHand' }, cards: cards('6S 7S 8S 9S 10S JS QS KS AS 6H 7H 8H') } as AnimationEvent];
    for (const p of ['a', 'b', 'c', 'd', 'e']) events.push(drawn(p, 6));
    events.push(deck);
    const t = scheduleEvents(events, { reduced: false });
    expect(t.totalMs).toBeLessThanOrEqual(M.resolutionBudgetMs);
    const draws = t.items.filter((i) => i.event.type === 'drawn');
    expect(draws[0]!.staggerMs).toBeLessThan(M.drawStaggerMs);
    const last = draws[draws.length - 1]!;
    expect(cardStart(last, 5) + last.durationMs).toBeLessThanOrEqual(M.resolutionBudgetMs);
  });

  it('reduced motion: every item is a quick fade with no delay or stagger', () => {
    const t = scheduleEvents([played, beaten, drawn('a', 3), deck], { reduced: true });
    for (const i of t.items) expect(i).toMatchObject({ startMs: 0, durationMs: M.reducedFadeMs, staggerMs: 0 });
    expect(t.totalMs).toBe(M.reducedFadeMs);
  });

  it('nothing to animate -> empty timeline', () => {
    expect(scheduleEvents([], { reduced: false })).toEqual({ items: [], totalMs: 0 });
  });
});
