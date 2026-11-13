import { cardId, type Card, type PlayerId, type PlayerView } from '@durak/shared';
import {
  inferBoutResolution,
  isBoutResolutionStep,
  leftViewerHand,
  viewDrawOrder,
  viewHandCounts,
  withoutCards,
} from '@durak/game-engine';

/**
 * Animation events inferred from two consecutive sanitized views — nothing else. Because the
 * input is what the viewer is allowed to see, an animation can never reveal a hidden card:
 * opponents' cards only ever appear as backs, except cards that were face-up on the table.
 */

/** Where a card comes from / goes to on screen. */
export type Origin = { readonly kind: 'myHand' } | { readonly kind: 'seat'; readonly playerId: PlayerId };

export type PlayKind = 'attack' | 'throwIn' | 'defend' | 'transfer';

export type AnimationEvent =
  | {
      readonly type: 'played';
      /** `null` when the views cannot tell who played it (the card then just fades in). */
      readonly by: PlayerId | null;
      readonly from: Origin | null;
      readonly card: Card;
      readonly kind: PlayKind;
      readonly slot: { readonly index: number; readonly role: 'attack' | 'defense' };
    }
  | { readonly type: 'beaten'; readonly cards: readonly Card[] }
  | { readonly type: 'taken'; readonly by: PlayerId; readonly to: Origin; readonly cards: readonly Card[] }
  | {
      readonly type: 'drawn';
      readonly player: PlayerId;
      readonly to: Origin;
      readonly count: number;
      /** The exact cards only for the viewer's own draws; `null` (backs) for everyone else. */
      readonly cards: readonly Card[] | null;
      /** This draw took the last card of the stock: the face-up trump. */
      readonly includesTrump: boolean;
    }
  | { readonly type: 'deck'; readonly from: number; readonly to: number; readonly trumpGone: boolean };

export function diffViews(prev: PlayerView, next: PlayerView): AnimationEvent[] {
  if (prev.viewerId !== next.viewerId) return [];
  if (prev.players.length !== next.players.length || prev.players.some((p, i) => p.id !== next.players[i]!.id)) return [];
  if (prev.phase.kind === 'finished') return [];

  if (isBoutResolutionStep(prev, next)) return resolution(prev, next) ?? [];
  if (next.boutNumber !== prev.boutNumber) return [];
  return plays(prev, next) ?? [];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const idOf = cardId;

function origin(view: PlayerView, playerId: PlayerId): Origin {
  return playerId === view.viewerId ? { kind: 'myHand' } : { kind: 'seat', playerId };
}

// ---------------------------------------------------------------------------
// within a bout: attack, throw-in, defense, transfer
// ---------------------------------------------------------------------------

function plays(prev: PlayerView, next: PlayerView): AnimationEvent[] | null {
  if (next.table.length < prev.table.length) return null;
  const before = viewHandCounts(prev);
  const droppers = next.players.filter((p) => p.handCount < (before.get(p.id) ?? 0)).map((p) => p.id);
  const playerOf = (card: Card, known: PlayerId | null): PlayerId | null => {
    if (leftViewerHand(prev, next, card)) return prev.viewerId;
    if (known !== null) return known;
    return droppers.length === 1 ? droppers[0]! : null;
  };
  const event = (card: Card, kind: PlayKind, index: number, role: 'attack' | 'defense', known: PlayerId | null): AnimationEvent => {
    const by = playerOf(card, known);
    return { type: 'played', by, from: by === null ? null : origin(next, by), card, kind, slot: { index, role } };
  };

  const events: AnimationEvent[] = [];
  for (let i = 0; i < prev.table.length; i++) {
    const a = prev.table[i]!;
    const b = next.table[i]!;
    if (idOf(a.attack) !== idOf(b.attack)) return null;
    if (a.defense && (!b.defense || idOf(a.defense) !== idOf(b.defense))) return null;
    if (!a.defense && b.defense) events.push(event(b.defense, 'defend', i, 'defense', prev.defenderId));
  }
  const transferred = next.defenderId !== prev.defenderId;
  for (let i = prev.table.length; i < next.table.length; i++) {
    const pair = next.table[i]!;
    const kind: PlayKind = prev.table.length === 0 ? 'attack' : transferred ? 'transfer' : 'throwIn';
    events.push(event(pair.attack, kind, i, 'attack', kind === 'transfer' ? prev.defenderId : null));
    if (pair.defense) return null; // a new pair can't arrive already covered
  }
  return events;
}

// ---------------------------------------------------------------------------
// bout resolution: closing card, beaten/taken, draws, deck
// ---------------------------------------------------------------------------

function resolution(prev: PlayerView, next: PlayerView): AnimationEvent[] | null {
  const inferred = inferBoutResolution(prev, next);
  const last = next.lastBout;
  if (!inferred || !last) return null;
  const { finalCards: final, closing, taker, scenarios } = inferred;

  const events: AnimationEvent[] = [];
  if (closing) {
    const by = scenarios.length === 1 ? scenarios[0]!.closer : null;
    events.push({
      type: 'played',
      by,
      from: by === null ? null : origin(next, by),
      card: closing.card,
      kind: closing.role === 'defense' ? 'defend' : 'throwIn',
      slot: { index: closing.index, role: closing.role },
    });
  }

  if (last.outcome === 'beaten') events.push({ type: 'beaten', cards: [...final] });
  else events.push({ type: 'taken', by: last.defenderId, to: origin(next, last.defenderId), cards: [...final] });

  // Draws: only counts every scenario agrees on (an ambiguous closer can make two draws indistinguishable).
  const order = viewDrawOrder(prev);
  const agreed = order
    .map((id) => ({ id, count: scenarios[0]!.drawn.get(id) ?? 0 }))
    .filter(({ id, count }) => count > 0 && scenarios.every((s) => (s.drawn.get(id) ?? 0) === count));
  const stockEmptied = prev.deckCount > 0 && next.deckCount === 0;
  const lastDrawer = [...order].reverse().find((id) => (scenarios[0]!.drawn.get(id) ?? 0) > 0);

  for (const { id, count } of agreed) {
    let cards: Card[] | null = null;
    if (id === next.viewerId) {
      const kept = withoutCards(prev.hand, closing && leftViewerHand(prev, next, closing.card) ? [closing.card] : []);
      const gained = id === taker ? final : [];
      cards = withoutCards(next.hand, [...kept, ...gained]);
      if (cards.length !== count) return null;
    }
    events.push({
      type: 'drawn',
      player: id,
      to: origin(next, id),
      count,
      cards,
      includesTrump: stockEmptied && id === lastDrawer,
    });
  }

  if (next.deckCount < prev.deckCount) {
    events.push({ type: 'deck', from: prev.deckCount, to: next.deckCount, trumpGone: next.deckCount === 0 });
  }
  return events;
}
