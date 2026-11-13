import { cardId, type Card, type PlayerView } from '@durak/shared';
import { useState, type CSSProperties } from 'react';
import type { ClientGame } from '../net/store';
import { motionTokens as M } from '../theme/motion';
import { anchorKey, type AnchorRegistry, type Rect } from './anchors';
import { diffViews, type AnimationEvent } from './diffViews';
import { EMPTY_TIMELINE, cardStart, scheduleEvents, type Timeline } from './timeline';

/**
 * The animation for the game state currently on screen. The DOM always shows the latest state;
 * this only decorates it (flights on top, freshly arrived cards revealed when their flight lands).
 * A newer state replaces it entirely, so nothing ever waits for an animation.
 */
export interface BoardAnimation {
  /** The game version this animation belongs to (-1: none). */
  readonly version: number;
  readonly events: readonly AnimationEvent[];
  readonly timeline: Timeline;
  readonly reduced: boolean;
  /** Cards (by id) that appear only when their flight lands. */
  readonly reveal: ReadonlyMap<string, { readonly delayMs: number; readonly fadeMs: number }>;
}

const IDLE: BoardAnimation = { version: -1, events: [], timeline: EMPTY_TIMELINE, reduced: false, reveal: new Map() };

/** Consecutive versions of the same game are animated; anything else (first state, resync, reconnect) snaps. */
export function animationFor(prev: ClientGame | null, next: ClientGame | null, reduced: boolean, speed = 1): BoardAnimation {
  if (!next) return IDLE;
  const consecutive =
    prev !== null && prev.roomId === next.roomId && prev.gameId === next.gameId && next.version === prev.version + 1;
  const events = consecutive ? diffViews(prev.view, next.view) : [];
  const timeline = scheduleEvents(events, { reduced, speed });
  return { version: next.version, events, timeline, reduced, reveal: revealPlan(timeline, reduced) };
}

function revealPlan(timeline: Timeline, reduced: boolean): Map<string, { delayMs: number; fadeMs: number }> {
  const reveal = new Map<string, { delayMs: number; fadeMs: number }>();
  for (const item of timeline.items) {
    const e = item.event;
    if (e.type === 'played') {
      // My own card glides from my hand (shared layoutId); other cards wait for their flight.
      if (reduced) reveal.set(cardId(e.card), { delayMs: 0, fadeMs: M.reducedFadeMs });
      else if (e.from === null) reveal.set(cardId(e.card), { delayMs: item.startMs, fadeMs: M.reducedFadeMs });
      else if (e.from.kind === 'seat') reveal.set(cardId(e.card), { delayMs: item.startMs + item.durationMs, fadeMs: 1 });
    } else if (e.type === 'drawn' && e.cards) {
      e.cards.forEach((card, k) =>
        reveal.set(cardId(card), reduced ? { delayMs: 0, fadeMs: M.reducedFadeMs } : { delayMs: cardStart(item, k) + item.durationMs, fadeMs: 1 }),
      );
    } else if (e.type === 'taken' && reduced && e.to.kind === 'myHand') {
      for (const card of e.cards) reveal.set(cardId(card), { delayMs: 0, fadeMs: M.reducedFadeMs });
    }
  }
  return reveal;
}

/** React state pattern for "derive from the previous prop" (safe under StrictMode double render). */
export function useBoardAnimation(game: ClientGame | null, reduced: boolean, speed = 1): BoardAnimation {
  const [tracked, setTracked] = useState<{ game: ClientGame | null; anim: BoardAnimation }>(() => ({
    game,
    anim: animationFor(null, game, reduced, speed),
  }));
  if (tracked.game !== game) {
    const anim = animationFor(tracked.game, game, reduced, speed);
    setTracked({ game, anim });
    return anim;
  }
  return tracked.anim;
}

/** Inline style hiding a card until its reveal time (none -> visible at once). */
export function revealStyle(anim: BoardAnimation, card: Card): CSSProperties | undefined {
  const r = anim.reveal.get(cardId(card));
  if (!r) return undefined;
  return { animation: `reveal ${r.fadeMs}ms linear ${r.delayMs}ms both` };
}

// ---------------------------------------------------------------------------
// flights
// ---------------------------------------------------------------------------

export interface Flight {
  readonly key: string;
  /** Face-up card, or null for a back. */
  readonly face: Card | null;
  readonly from: Rect;
  readonly to: Rect;
  readonly delayMs: number;
  readonly durationMs: number;
  /** Fade out on arrival (absorbed by a seat / the discard pile). */
  readonly vanish: boolean;
  readonly rotate: number;
}

const SEAT_CARD = { width: 20, height: 29 };

/** A small card-sized box centered on an anchor (seats are larger than a card). */
function centered(rect: Rect, size: { width: number; height: number }): Rect {
  return { x: rect.x + rect.width / 2 - size.width / 2, y: rect.y + rect.height / 2 - size.height / 2, ...size };
}

const usable = (r: Rect | null): r is Rect => r !== null && r.width > 0 && r.height > 0;

/**
 * Turns the timeline into concrete flights between anchors. Called right after the new state is
 * committed: `previous` rects still describe the old screen (e.g. cards just swept off the table).
 */
export function planFlights(anim: BoardAnimation, view: PlayerView, anchors: AnchorRegistry): Flight[] {
  if (anim.reduced) return [];
  const flights: Flight[] = [];
  const push = (f: Omit<Flight, 'key'>) => flights.push({ ...f, key: `${anim.version}:${flights.length}` });

  for (const item of anim.timeline.items) {
    const e = item.event;
    switch (e.type) {
      case 'played': {
        if (e.from?.kind !== 'seat') break; // mine: shared layoutId; unknown: fades in
        const from = anchors.live(anchorKey.seat(e.from.playerId));
        const to = anchors.live(anchorKey.card(cardId(e.card)));
        if (usable(from) && usable(to)) {
          push({
            face: e.card,
            from: centered(from, to),
            to,
            delayMs: item.startMs,
            durationMs: item.durationMs,
            vanish: false,
            rotate: e.slot.role === 'defense' ? M.defenseRotateDeg : 0,
          });
        }
        break;
      }
      case 'beaten':
      case 'taken': {
        if (e.type === 'taken' && e.to.kind === 'myHand') break; // shared layoutId into my hand
        const target = e.type === 'beaten' ? anchors.any(anchorKey.discard) : anchors.live(anchorKey.seat(e.by));
        if (!usable(target)) break;
        e.cards.forEach((card, k) => {
          const from = anchors.previous(anchorKey.card(cardId(card)));
          if (!usable(from)) return;
          push({
            face: card,
            from,
            to: e.type === 'beaten' ? target : centered(target, SEAT_CARD),
            delayMs: cardStart(item, k),
            durationMs: item.durationMs,
            vanish: true,
            rotate: e.type === 'beaten' ? (k % 2 ? -12 : 10) : 0,
          });
        });
        break;
      }
      case 'drawn': {
        const deck = anchors.any(anchorKey.deck);
        const trump = anchors.any(anchorKey.trump);
        for (let k = 0; k < e.count; k++) {
          const lastOfStock = e.includesTrump && k === e.count - 1;
          const from = lastOfStock && usable(trump) ? trump : deck;
          const mine = e.cards?.[k];
          const to = mine ? anchors.live(anchorKey.card(cardId(mine))) : anchors.live(anchorKey.seat(e.player));
          if (!usable(from) || !usable(to)) continue;
          push({
            // Only the public trump is shown face-up on its way to an opponent; my cards are revealed on landing.
            face: lastOfStock ? view.trumpCard : null,
            from: mine ? centered(from, to) : from,
            to: mine ? to : centered(to, SEAT_CARD),
            delayMs: cardStart(item, k),
            durationMs: item.durationMs,
            vanish: !mine,
            rotate: 0,
          });
        }
        break;
      }
      case 'deck':
        break;
    }
  }
  return flights;
}
