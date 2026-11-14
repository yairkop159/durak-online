import type { PlayerId, PlayerView } from '@durak/shared';
import type { AnimationEvent } from './diffViews';
import type { Timeline } from './timeline';

/**
 * Game "moments": short banners (+ a seat effect and a sound) for the big things that happen,
 * derived from two consecutive sanitized views and their animation events only. No new server
 * messages, and nothing a player couldn't see.
 */
export type Moment =
  | { readonly type: 'wentOut'; readonly players: readonly PlayerId[] }
  | { readonly type: 'deckOut'; readonly trumpTo: PlayerId | null }
  | { readonly type: 'bigTake'; readonly by: PlayerId; readonly count: number }
  | { readonly type: 'transfer'; readonly from: PlayerId; readonly to: PlayerId }
  | { readonly type: 'perfectDefense'; readonly by: PlayerId; readonly pairs: number };

export type MomentType = Moment['type'];

/** Highest first: when too many queue up, the lowest are dropped. */
export const MOMENT_PRIORITY: readonly MomentType[] = ['wentOut', 'deckOut', 'bigTake', 'transfer', 'perfectDefense'];

/** A take this big is a moment. */
export const BIG_TAKE_MIN_CARDS = 4;
/** A beaten bout this big is a "perfect defense" (every beaten bout is fully covered). */
export const PERFECT_DEFENSE_MIN_PAIRS = 3;
/** At most this many banners wait in line. */
export const MAX_QUEUED_MOMENTS = 3;
/** How long one banner stays up (scaled by the animation speed). */
export const MOMENT_BANNER_MS = 1600;

export interface PlannedMoment {
  readonly moment: Moment;
  /** When its banner may appear (ms after the state arrived): once its animation has landed. */
  readonly atMs: number;
}

const byPriority = (a: Moment, b: Moment) => MOMENT_PRIORITY.indexOf(a.type) - MOMENT_PRIORITY.indexOf(b.type);

/** The moments of one step, highest priority first (at most MAX_QUEUED_MOMENTS). */
export function momentsFor(prev: PlayerView, next: PlayerView, events: readonly AnimationEvent[]): Moment[] {
  // The game's last step belongs to the durak reveal.
  if (next.phase.kind === 'finished' || events.length === 0) return [];
  const out: Moment[] = [];

  const newlyOut = next.finishOrder.filter((id) => !prev.finishOrder.includes(id));
  if (newlyOut.length > 0) out.push({ type: 'wentOut', players: newlyOut });

  if (prev.deckCount > 0 && next.deckCount === 0) {
    const trumpDraw = events.find((e) => e.type === 'drawn' && e.includesTrump);
    out.push({ type: 'deckOut', trumpTo: trumpDraw && trumpDraw.type === 'drawn' ? trumpDraw.player : null });
  }

  for (const e of events) {
    if (e.type === 'taken' && e.cards.length >= BIG_TAKE_MIN_CARDS) out.push({ type: 'bigTake', by: e.by, count: e.cards.length });
    if (e.type === 'played' && e.kind === 'transfer') out.push({ type: 'transfer', from: e.by ?? prev.defenderId, to: next.defenderId });
    if (e.type === 'beaten' && e.cards.length / 2 >= PERFECT_DEFENSE_MIN_PAIRS) {
      out.push({ type: 'perfectDefense', by: next.lastBout?.defenderId ?? prev.defenderId, pairs: e.cards.length / 2 });
    }
  }
  return out.sort(byPriority).slice(0, MAX_QUEUED_MOMENTS);
}

/** Each moment appears once the animation it belongs to has landed. */
export function scheduleMoments(moments: readonly Moment[], timeline: Timeline): PlannedMoment[] {
  const endOf = (pred: (e: AnimationEvent) => boolean) => {
    const items = timeline.items.filter((i) => pred(i.event));
    return items.length === 0 ? timeline.totalMs : Math.max(...items.map((i) => i.startMs + i.durationMs));
  };
  return moments.map((moment) => ({
    moment,
    atMs:
      moment.type === 'transfer'
        ? endOf((e) => e.type === 'played' && e.kind === 'transfer')
        : moment.type === 'bigTake' || moment.type === 'perfectDefense'
          ? endOf((e) => e.type === 'taken' || e.type === 'beaten')
          : timeline.totalMs,
  }));
}

/** The seat effect a moment shows (who and how). */
export type SeatEffect = 'celebrate' | 'shake' | 'shine' | 'pulse';

export function seatEffects(moment: Moment): ReadonlyMap<PlayerId, SeatEffect> {
  switch (moment.type) {
    case 'wentOut':
      return new Map(moment.players.map((id) => [id, 'celebrate' as const]));
    case 'deckOut':
      return moment.trumpTo ? new Map([[moment.trumpTo, 'shine' as const]]) : new Map();
    case 'bigTake':
      return new Map([[moment.by, 'shake' as const]]);
    case 'transfer':
      return new Map([[moment.to, 'pulse' as const]]);
    case 'perfectDefense':
      return new Map([[moment.by, 'shine' as const]]);
  }
}

/**
 * The banner queue (pure): new moments join, sorted by priority behind whatever is waiting, and
 * the lowest are dropped beyond MAX_QUEUED_MOMENTS.
 */
export function enqueueMoments<T extends { readonly moment: Moment }>(queue: readonly T[], incoming: readonly T[]): T[] {
  const merged = [...queue, ...incoming];
  if (merged.length <= MAX_QUEUED_MOMENTS) return merged;
  const keep = [...merged].sort((a, b) => byPriority(a.moment, b.moment)).slice(0, MAX_QUEUED_MOMENTS);
  return merged.filter((m) => keep.includes(m));
}
