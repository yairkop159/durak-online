import { motionTokens as M } from '../theme/motion';
import type { AnimationEvent } from './diffViews';

/**
 * When each event animates. Pure: (events, reduced) -> timeline. Order:
 *   1. played (a closing card lands first)
 *   2. beaten | taken (resolution)
 *   3. drawn, card by card in draw order, staggered, compressed to fit the budget
 */
export interface TimelineItem {
  readonly event: AnimationEvent;
  /** When the first card of this event starts moving (ms after the state arrived). */
  readonly startMs: number;
  /** Duration of one card's movement. */
  readonly durationMs: number;
  /** Delay between consecutive cards of the same event (0 for single-card events). */
  readonly staggerMs: number;
}

export interface Timeline {
  readonly items: readonly TimelineItem[];
  /** When the last card has landed. */
  readonly totalMs: number;
}

export const EMPTY_TIMELINE: Timeline = { items: [], totalMs: 0 };

export function cardCount(event: AnimationEvent): number {
  switch (event.type) {
    case 'played':
      return 1;
    case 'beaten':
    case 'taken':
      return event.cards.length;
    case 'drawn':
      return event.count;
    case 'deck':
      return 0;
  }
}

/** Start time of card `k` of an item. */
export function cardStart(item: TimelineItem, k: number): number {
  return item.startMs + k * item.staggerMs;
}

/**
 * `speed` scales every duration (1 = normal, 0.6 = "fast" in the settings). Reduced motion ignores
 * it: those quick fades are already as short as they should be.
 */
export function scheduleEvents(events: readonly AnimationEvent[], options: { reduced: boolean; speed?: number }): Timeline {
  if (events.length === 0) return EMPTY_TIMELINE;
  const speed = options.speed ?? 1;

  if (options.reduced) {
    const items = events.map((event) => ({ event, startMs: 0, durationMs: M.reducedFadeMs, staggerMs: 0 }));
    return { items, totalMs: M.reducedFadeMs };
  }

  const timeline = scheduleNormal(events);
  if (speed === 1) return timeline;
  const scale = (ms: number) => Math.round(ms * speed);
  return {
    items: timeline.items.map((i) => ({ ...i, startMs: scale(i.startMs), durationMs: scale(i.durationMs), staggerMs: scale(i.staggerMs) })),
    totalMs: scale(timeline.totalMs),
  };
}

function scheduleNormal(events: readonly AnimationEvent[]): Timeline {
  const items: TimelineItem[] = [];
  const played = events.filter((e) => e.type === 'played');
  const resolution = events.filter((e) => e.type === 'beaten' || e.type === 'taken');
  const draws = events.filter((e) => e.type === 'drawn');
  const deck = events.filter((e) => e.type === 'deck');

  for (const event of played) items.push({ event, startMs: 0, durationMs: M.playMs, staggerMs: 0 });

  const resolutionStart = played.length > 0 && resolution.length > 0 ? M.playToResolutionMs : 0;
  for (const event of resolution) {
    items.push({ event, startMs: resolutionStart, durationMs: M.sweepMs, staggerMs: M.sweepStaggerMs });
  }

  const drawStart = resolution.length > 0 ? resolutionStart + M.resolutionToDrawMs : 0;
  const drawCards = draws.reduce((n, e) => n + cardCount(e), 0);
  const room = M.resolutionBudgetMs - drawStart - M.drawFlightMs;
  const stagger = drawCards > 1 ? Math.max(0, Math.min(M.drawStaggerMs, Math.floor(room / (drawCards - 1)))) : 0;
  let k = 0;
  for (const event of draws) {
    items.push({ event, startMs: drawStart + k * stagger, durationMs: M.drawFlightMs, staggerMs: stagger });
    k += cardCount(event);
  }
  const drawsEnd = drawCards > 0 ? drawStart + (drawCards - 1) * stagger + M.drawFlightMs : drawStart;
  for (const event of deck) {
    items.push({ event, startMs: drawStart, durationMs: Math.max(M.drawFlightMs, drawsEnd - drawStart), staggerMs: 0 });
  }

  const totalMs = items.reduce((end, item) => Math.max(end, cardStart(item, Math.max(0, cardCount(item.event) - 1)) + item.durationMs), 0);
  return { items, totalMs };
}
