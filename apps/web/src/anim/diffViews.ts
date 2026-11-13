import { HAND_SIZE, cardId, type Card, type PlayerId, type PlayerView, type TablePair } from '@durak/shared';

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

  const boutDelta = next.boutNumber - prev.boutNumber;
  // A bout that ends the game resolves without a new bout number.
  const finishedByBout =
    boutDelta === 0 && next.phase.kind === 'finished' && prev.table.length > 0 && next.table.length === 0;
  if (boutDelta === 1 || finishedByBout) return resolution(prev, next) ?? [];
  if (boutDelta !== 0) return [];
  return plays(prev, next) ?? [];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const idOf = cardId;

function tableCards(table: readonly TablePair[]): Card[] {
  return table.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack]));
}

/** Multiset difference by card id: `from` without (one copy of) each card in `remove`. */
function without(from: readonly Card[], remove: readonly Card[]): Card[] {
  const left = remove.map(idOf);
  const out: Card[] = [];
  for (const card of from) {
    const i = left.indexOf(idOf(card));
    if (i === -1) out.push(card);
    else left.splice(i, 1);
  }
  return out;
}

function includes(list: readonly Card[], card: Card): boolean {
  return list.some((c) => idOf(c) === idOf(card));
}

function origin(view: PlayerView, playerId: PlayerId): Origin {
  return playerId === view.viewerId ? { kind: 'myHand' } : { kind: 'seat', playerId };
}

function handCounts(view: PlayerView): Map<PlayerId, number> {
  return new Map(view.players.map((p) => [p.id, p.handCount]));
}

/** Did this card leave the viewer's own hand between the two views? */
function leftMyHand(prev: PlayerView, next: PlayerView, card: Card): boolean {
  return prev.viewerId !== null && includes(prev.hand, card) && !includes(next.hand, card);
}

// ---------------------------------------------------------------------------
// within a bout: attack, throw-in, defense, transfer
// ---------------------------------------------------------------------------

function plays(prev: PlayerView, next: PlayerView): AnimationEvent[] | null {
  if (next.table.length < prev.table.length) return null;
  const before = handCounts(prev);
  const droppers = next.players.filter((p) => p.handCount < (before.get(p.id) ?? 0)).map((p) => p.id);
  const playerOf = (card: Card, known: PlayerId | null): PlayerId | null => {
    if (leftMyHand(prev, next, card)) return prev.viewerId;
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

/** Players in the real draw order: main attacker, then clockwise, the defender last; finished players skipped. */
function drawOrder(view: PlayerView): PlayerId[] {
  const n = view.players.length;
  const start = view.players.findIndex((p) => p.id === view.attackerId);
  const order: PlayerId[] = [];
  for (let step = 0; step < n; step++) {
    const p = view.players[(start + step) % n]!;
    if (p.id !== view.defenderId && !p.finished) order.push(p.id);
  }
  const defender = view.players.find((p) => p.id === view.defenderId);
  if (defender && !defender.finished) order.push(defender.id);
  return order;
}

/**
 * Replays the refill rule from `prev` with the table effect applied. Returns how many cards each
 * player drew, or null if the result doesn't reproduce `next` (so this scenario is impossible).
 */
function simulateDraws(
  prev: PlayerView,
  next: PlayerView,
  delta: ReadonlyMap<PlayerId, number>,
): Map<PlayerId, number> | null {
  const counts = handCounts(prev);
  for (const [id, d] of delta) counts.set(id, (counts.get(id) ?? 0) + d);
  let deck = prev.deckCount;
  const drawn = new Map<PlayerId, number>();
  for (const id of drawOrder(prev)) {
    let have = counts.get(id) ?? 0;
    let got = 0;
    while (have < HAND_SIZE && deck > 0) {
      have++;
      got++;
      deck--;
    }
    counts.set(id, have);
    if (got > 0) drawn.set(id, got);
  }
  if (deck !== next.deckCount) return null;
  for (const p of next.players) if (counts.get(p.id) !== p.handCount) return null;
  return drawn;
}

function resolution(prev: PlayerView, next: PlayerView): AnimationEvent[] | null {
  const last = next.lastBout;
  if (!last || next.table.length !== 0 || prev.table.length === 0) return null;

  // The final table = what we saw plus at most one closing card (a defense, or a throw-in during a take).
  const seen = tableCards(prev.table);
  const final = tableCards(last.table);
  if (without(seen, final).length !== 0) return null;
  const extra = without(final, seen);
  if (extra.length > 1) return null;

  const events: AnimationEvent[] = [];
  const taker = last.outcome === 'taken' ? last.defenderId : null;
  const tableDelta = (closer: PlayerId | null): Map<PlayerId, number> => {
    const delta = new Map<PlayerId, number>();
    if (closer !== null) delta.set(closer, -1);
    if (taker !== null) delta.set(taker, (delta.get(taker) ?? 0) + final.length);
    return delta;
  };

  // Every scenario consistent with the views: who closed the bout -> how many each player drew.
  let scenarios: { closer: PlayerId | null; drawn: Map<PlayerId, number> }[] = [];
  const closing = extra[0];
  if (closing) {
    const index = last.table.findIndex((p) => idOf(p.attack) === idOf(closing) || (p.defense && idOf(p.defense) === idOf(closing)));
    const pair = last.table[index]!;
    const isDefense = pair.defense !== null && idOf(pair.defense) === idOf(closing);
    if (isDefense && index >= prev.table.length) return null;
    const kind: PlayKind = isDefense ? 'defend' : 'throwIn';

    let candidates: PlayerId[];
    if (isDefense) candidates = [last.defenderId];
    else if (leftMyHand(prev, next, closing)) candidates = [prev.viewerId!];
    else {
      candidates = prev.players
        .filter((p) => p.id !== last.defenderId && p.id !== prev.viewerId && !p.finished && p.handCount > 0)
        .map((p) => p.id);
    }
    for (const closer of candidates) {
      const drawn = simulateDraws(prev, next, tableDelta(closer));
      if (drawn) scenarios.push({ closer, drawn });
    }
    if (scenarios.length === 0) return null;
    const by = scenarios.length === 1 ? scenarios[0]!.closer : null;
    events.push({
      type: 'played',
      by,
      from: by === null ? null : origin(next, by),
      card: closing,
      kind,
      slot: { index, role: isDefense ? 'defense' : 'attack' },
    });
  } else {
    const drawn = simulateDraws(prev, next, tableDelta(null));
    if (!drawn) return null;
    scenarios = [{ closer: null, drawn }];
  }

  if (last.outcome === 'beaten') {
    if (next.discardCount - prev.discardCount !== final.length) return null;
    events.push({ type: 'beaten', cards: final });
  } else {
    if (next.discardCount !== prev.discardCount) return null;
    events.push({ type: 'taken', by: last.defenderId, to: origin(next, last.defenderId), cards: final });
  }

  // Draws: only counts every scenario agrees on (an ambiguous closer can make two draws indistinguishable).
  const order = drawOrder(prev);
  const agreed = order
    .map((id) => ({ id, count: scenarios[0]!.drawn.get(id) ?? 0 }))
    .filter(({ id, count }) => count > 0 && scenarios.every((s) => (s.drawn.get(id) ?? 0) === count));
  const stockEmptied = prev.deckCount > 0 && next.deckCount === 0;
  const lastDrawer = [...order].reverse().find((id) => (scenarios[0]!.drawn.get(id) ?? 0) > 0);

  for (const { id, count } of agreed) {
    let cards: Card[] | null = null;
    if (id === next.viewerId) {
      const kept = without(prev.hand, closing && leftMyHand(prev, next, closing) ? [closing] : []);
      const gained = id === taker ? final : [];
      cards = without(next.hand, [...kept, ...gained]);
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
