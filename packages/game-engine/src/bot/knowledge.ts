import { cardId, type Card, type PlayerId, type PlayerView } from '@durak/shared';
import { createDeck } from '../deck.js';
import { inferBoutResolution, isBoutResolutionStep, tableCards, viewDrawOrder } from '../viewInference.js';

/** A card id as produced by `cardId` ("10H", "AS"). */
export type CardId = string;

/**
 * What a player can PROVE about hidden card locations from the views they received.
 * Built only from `PlayerView`s, so it holds nothing a human at the table couldn't know.
 * Plain JSON (no Sets or Maps), so it can be persisted as-is.
 *
 * Soundness invariant (checked by property tests against the real state):
 *   - every card in `discard` is in the real discard pile;
 *   - every card in `knownHands[p]` is in player p's real hand.
 */
export interface PublicKnowledge {
  readonly viewerId: PlayerId | null;
  /** Cards proven to be in the discard pile (a subset of it when we joined mid-game). */
  readonly discard: readonly CardId[];
  /** Opponents only: cards proven to be in that opponent's hand (picked up via a take, or the drawn trump). */
  readonly knownHands: Readonly<Record<PlayerId, readonly CardId[]>>;
}

const ALL_CARDS: readonly Card[] = createDeck();
const CARD_BY_ID: ReadonlyMap<CardId, Card> = new Map(ALL_CARDS.map((c) => [cardId(c), c]));

export function cardFromId(id: CardId): Card {
  const card = CARD_BY_ID.get(id);
  if (!card) throw new Error(`Unknown card id ${id}`);
  return card;
}

const ids = (cards: readonly Card[]): CardId[] => cards.map(cardId);

function union(a: readonly CardId[], b: readonly CardId[]): CardId[] {
  const out = [...a];
  for (const id of b) if (!out.includes(id)) out.push(id);
  return out;
}

/** Knowledge from a single view (no history): only what this view alone proves. */
export function initKnowledge(view: PlayerView): PublicKnowledge {
  const discard = view.lastBout?.outcome === 'beaten' ? ids(tableCards(view.lastBout.table)) : [];
  const knownHands: Record<PlayerId, CardId[]> = {};
  for (const p of view.players) if (p.id !== view.viewerId) knownHands[p.id] = [];

  // With 6 players the deal empties the stock and the trump is the last card dealt: seat 5 holds it
  // until bout 1 resolves (if it was played in bout 1 it is visible on the table and filtered below).
  const lastSeat = view.players[view.players.length - 1];
  if (view.boutNumber === 1 && view.players.length * 6 === ALL_CARDS.length && lastSeat && lastSeat.id !== view.viewerId) {
    knownHands[lastSeat.id] = [cardId(view.trumpCard)];
  }
  return normalize({ viewerId: view.viewerId, discard, knownHands }, view) ?? { viewerId: view.viewerId, discard, knownHands: emptyHands(view) };
}

/**
 * Advances knowledge by one step, from the view `prev` (the one `knowledge` is synced to) to `next`.
 * Missing or inconsistent steps degrade gracefully: the discard is kept (cards never leave it) and
 * the per-hand knowledge restarts from `next`.
 */
export function updateKnowledge(knowledge: PublicKnowledge, prev: PlayerView, next: PlayerView): PublicKnowledge {
  const samePlayers =
    prev.players.length === next.players.length && prev.players.every((p, i) => p.id === next.players[i]!.id);
  if (knowledge.viewerId !== next.viewerId || prev.viewerId !== next.viewerId || !samePlayers) {
    return initKnowledge(next);
  }
  if (prev.phase.kind === 'finished') return knowledge;

  const fresh = (): PublicKnowledge => {
    const base = initKnowledge(next);
    return { ...base, discard: union(knowledge.discard, base.discard) };
  };

  let discard = knowledge.discard;
  const knownHands: Record<PlayerId, CardId[]> = {};
  for (const [id, cards] of Object.entries(knowledge.knownHands)) knownHands[id] = [...cards];

  if (isBoutResolutionStep(prev, next)) {
    const resolution = inferBoutResolution(prev, next);
    const last = next.lastBout;
    if (!resolution || !last) return fresh();
    const boutIds = ids(resolution.finalCards);
    if (last.outcome === 'beaten') {
      discard = union(discard, boutIds);
    } else {
      // The defender picked up every table card: they are in that hand now, and nowhere else.
      for (const id of Object.keys(knownHands)) knownHands[id] = knownHands[id]!.filter((c) => !boutIds.includes(c));
      if (last.defenderId !== next.viewerId) knownHands[last.defenderId] = union(knownHands[last.defenderId] ?? [], boutIds);
    }

    // The stock ran out: its last card (the face-up trump) went to the last player who drew.
    if (prev.deckCount > 0 && next.deckCount === 0) {
      const order = viewDrawOrder(prev);
      const drawers = resolution.scenarios.map((s) => [...order].reverse().find((id) => (s.drawn.get(id) ?? 0) > 0));
      const drawer = drawers[0];
      if (drawer !== undefined && drawer !== next.viewerId && drawers.every((d) => d === drawer)) {
        knownHands[drawer] = union(knownHands[drawer] ?? [], [cardId(next.trumpCard)]);
      }
    }
  } else if (next.boutNumber !== prev.boutNumber) {
    return fresh(); // we missed at least one bout resolution
  }

  return normalize({ viewerId: knowledge.viewerId, discard, knownHands }, next) ?? fresh();
}

function emptyHands(view: PlayerView): Record<PlayerId, CardId[]> {
  const hands: Record<PlayerId, CardId[]> = {};
  for (const p of view.players) if (p.id !== view.viewerId) hands[p.id] = [];
  return hands;
}

/**
 * Drops hand knowledge that `view` shows to be stale (the card is now visible elsewhere) and checks
 * consistency. Returns null if the knowledge cannot be right for this view.
 */
function normalize(k: PublicKnowledge, view: PlayerView): PublicKnowledge | null {
  const visible = new Set([...ids(view.hand), ...ids(tableCards(view.table)), ...k.discard]);
  if (k.discard.length > view.discardCount) return null;
  const knownHands: Record<PlayerId, CardId[]> = {};
  const claimed = new Set<CardId>();
  for (const p of view.players) {
    if (p.id === view.viewerId) continue;
    const known = p.finished ? [] : (k.knownHands[p.id] ?? []).filter((c) => !visible.has(c));
    if (known.length > p.handCount) return null;
    for (const c of known) {
      if (claimed.has(c)) return null;
      claimed.add(c);
    }
    knownHands[p.id] = known;
  }
  // The face-up trump is still at the bottom of the stock: nobody can hold it.
  if (view.deckCount > 0 && claimed.has(cardId(view.trumpCard))) return null;
  return { viewerId: k.viewerId, discard: k.discard, knownHands };
}

/**
 * Cards whose location the viewer cannot pin down: not in their hand, not on the table, not proven
 * discarded, not proven in an opponent's hand, and not the face-up trump while the stock lasts.
 * Returned in a fixed (deck) order.
 */
export function unseenCards(knowledge: PublicKnowledge, view: PlayerView): Card[] {
  const placed = new Set<CardId>([...ids(view.hand), ...ids(tableCards(view.table)), ...knowledge.discard]);
  for (const cards of Object.values(knowledge.knownHands)) for (const c of cards) placed.add(c);
  if (view.deckCount > 0) placed.add(cardId(view.trumpCard));
  return ALL_CARDS.filter((c) => !placed.has(cardId(c)));
}
