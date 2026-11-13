import { HAND_SIZE, cardId, type Card, type PlayerId, type PlayerView, type TablePair } from '@durak/shared';

/**
 * Inference from two consecutive sanitized views: nothing else goes in, so nothing hidden can come
 * out. Shared by the web client's animations (`apps/web/src/anim/diffViews.ts`) and the bot's
 * `PublicKnowledge` (`src/bot/knowledge.ts`).
 */

/** Every card on a table, attack before defense, pair by pair. */
export function tableCards(table: readonly TablePair[]): Card[] {
  return table.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack]));
}

/** Multiset difference by card id: `from` without (one copy of) each card in `remove`. */
export function withoutCards(from: readonly Card[], remove: readonly Card[]): Card[] {
  const left = remove.map(cardId);
  const out: Card[] = [];
  for (const card of from) {
    const i = left.indexOf(cardId(card));
    if (i === -1) out.push(card);
    else left.splice(i, 1);
  }
  return out;
}

export function includesCard(list: readonly Card[], card: Card): boolean {
  const id = cardId(card);
  return list.some((c) => cardId(c) === id);
}

/** Did this card leave the viewer's own hand between the two views? */
export function leftViewerHand(prev: PlayerView, next: PlayerView, card: Card): boolean {
  return prev.viewerId !== null && includesCard(prev.hand, card) && !includesCard(next.hand, card);
}

export function viewHandCounts(view: PlayerView): Map<PlayerId, number> {
  return new Map(view.players.map((p) => [p.id, p.handCount]));
}

/** Players in the real draw order: main attacker, then clockwise, the defender last; finished players skipped. */
export function viewDrawOrder(view: PlayerView): PlayerId[] {
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
 * Replays the refill rule from `prev` with the table effect `delta` applied. Returns how many cards
 * each player drew, or null if the result doesn't reproduce `next` (so this scenario is impossible).
 */
export function simulateViewDraws(
  prev: PlayerView,
  next: PlayerView,
  delta: ReadonlyMap<PlayerId, number>,
): Map<PlayerId, number> | null {
  const counts = viewHandCounts(prev);
  for (const [id, d] of delta) counts.set(id, (counts.get(id) ?? 0) + d);
  let deck = prev.deckCount;
  const drawn = new Map<PlayerId, number>();
  for (const id of viewDrawOrder(prev)) {
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

/** True when `next` is the view right after the bout shown in `prev` resolved. */
export function isBoutResolutionStep(prev: PlayerView, next: PlayerView): boolean {
  const boutDelta = next.boutNumber - prev.boutNumber;
  // A bout that ends the game resolves without a new bout number.
  const finishedByBout =
    boutDelta === 0 && next.phase.kind === 'finished' && prev.table.length > 0 && next.table.length === 0;
  return boutDelta === 1 || finishedByBout;
}

/** One way the resolution could have happened: who closed the bout, and how many cards each player drew. */
export interface DrawScenario {
  readonly closer: PlayerId | null;
  readonly drawn: ReadonlyMap<PlayerId, number>;
}

export interface BoutResolution {
  /** The bout's final table cards (`lastBout.table`). */
  readonly finalCards: readonly Card[];
  /** The one card that closed the bout inside the resolving move, if any (never seen on its own). */
  readonly closing: { readonly card: Card; readonly index: number; readonly role: 'attack' | 'defense' } | null;
  /** The defender if the bout was taken. */
  readonly taker: PlayerId | null;
  /** Every scenario consistent with both views; never empty. */
  readonly scenarios: readonly DrawScenario[];
}

/**
 * Explains a bout resolution step (`isBoutResolutionStep(prev, next)`) from the two views and
 * `next.lastBout`, or returns null if the views are inconsistent with any resolution.
 */
export function inferBoutResolution(prev: PlayerView, next: PlayerView): BoutResolution | null {
  const last = next.lastBout;
  if (!last || next.table.length !== 0 || prev.table.length === 0) return null;

  // The final table = what we saw plus at most one closing card (a defense, or a throw-in during a take).
  const seen = tableCards(prev.table);
  const finalCards = tableCards(last.table);
  if (withoutCards(seen, finalCards).length !== 0) return null;
  const extra = withoutCards(finalCards, seen);
  if (extra.length > 1) return null;

  const taker = last.outcome === 'taken' ? last.defenderId : null;
  const tableDelta = (closer: PlayerId | null): Map<PlayerId, number> => {
    const delta = new Map<PlayerId, number>();
    if (closer !== null) delta.set(closer, -1);
    if (taker !== null) delta.set(taker, (delta.get(taker) ?? 0) + finalCards.length);
    return delta;
  };

  const scenarios: DrawScenario[] = [];
  let closing: BoutResolution['closing'] = null;
  const closingCard = extra[0];
  if (closingCard) {
    const id = cardId(closingCard);
    const index = last.table.findIndex((p) => cardId(p.attack) === id || (p.defense !== null && cardId(p.defense) === id));
    const pair = last.table[index]!;
    const isDefense = pair.defense !== null && cardId(pair.defense) === id;
    if (isDefense && index >= prev.table.length) return null;
    closing = { card: closingCard, index, role: isDefense ? 'defense' : 'attack' };

    let candidates: PlayerId[];
    if (isDefense) candidates = [last.defenderId];
    else if (leftViewerHand(prev, next, closingCard)) candidates = [prev.viewerId!];
    else {
      candidates = prev.players
        .filter((p) => p.id !== last.defenderId && p.id !== prev.viewerId && !p.finished && p.handCount > 0)
        .map((p) => p.id);
    }
    for (const closer of candidates) {
      const drawn = simulateViewDraws(prev, next, tableDelta(closer));
      if (drawn) scenarios.push({ closer, drawn });
    }
  } else {
    const drawn = simulateViewDraws(prev, next, tableDelta(null));
    if (drawn) scenarios.push({ closer: null, drawn });
  }
  if (scenarios.length === 0) return null;

  if (last.outcome === 'beaten') {
    if (next.discardCount - prev.discardCount !== finalCards.length) return null;
  } else if (next.discardCount !== prev.discardCount) {
    return null;
  }
  return { finalCards, closing, taker, scenarios };
}
