import {
  GreedyBot,
  applyMove,
  canonicalActor,
  createDeck,
  createGameWithDeck,
  initKnowledge,
  sanitizeStateForPlayer,
  createRng,
  type GameState,
} from '@durak/game-engine';
import { RANKS, SUITS, sameCard, type Card, type GameConfigInput, type Move, type PlayerId, type Rank, type Suit } from '@durak/shared';

/** The learner's seat id in every tutorial game. */
export const ME: PlayerId = 'me';

const RANK_CODES: Record<string, Rank> = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };

/** `card('10C')`, `card('QH')`: rank (6-10, J, Q, K, A) then suit (S, C, D, H). */
export function card(code: string): Card {
  const suit = code.slice(-1) as Suit;
  const rank = RANK_CODES[code.slice(0, -1)];
  if (!SUITS.includes(suit) || rank === undefined || !RANKS.includes(rank)) throw new Error(`bad card code ${code}`);
  return { rank, suit };
}

export const cards = (codes: string): Card[] => codes.split(/\s+/).filter(Boolean).map(card);

/**
 * A full 36-card deck order that deals exactly `hands` (6 cards each, dealt round-robin from seat
 * 0, as the engine deals), then `stockTop` from the top of the stock, the remaining cards in deck
 * order, and `trump` last (the face-up trump). The engine validates it (`createGameWithDeck`).
 */
export function deckFor(hands: readonly string[], trump: string, stockTop = ''): Card[] {
  const dealt = hands.map(cards);
  const n = dealt.length;
  const order: Card[] = [];
  for (let round = 0; round < 6; round++) for (let seat = 0; seat < n; seat++) order.push(dealt[seat]![round]!);
  const top = cards(stockTop);
  const trumpCard = card(trump);
  const used = [...order, ...top, trumpCard];
  const rest = createDeck().filter((c) => !used.some((u) => sameCard(u, c)));
  return [...order, ...top, ...rest, trumpCard];
}

/** A lesson's state, built only through the engine: the deal, then each scripted move through `applyMove`. */
export function buildGame(
  playerIds: readonly PlayerId[],
  deck: readonly Card[],
  config: GameConfigInput,
  prefix: readonly Move[] = [],
): GameState {
  const created = createGameWithDeck(playerIds, deck, config);
  if (!created.ok) throw new Error(`tutorial deal rejected: ${created.error.code} ${created.error.message}`);
  let state = created.value;
  for (const move of prefix) state = mustApply(state, move);
  return state;
}

export function mustApply(state: GameState, move: Move): GameState {
  const next = applyMove(state, move);
  if (!next.ok) throw new Error(`tutorial move rejected: ${next.error.code} ${JSON.stringify(move)}`);
  return next.value;
}

const NO_RNG = createRng(1);

/** GreedyBot's move for `playerId`, chosen from that player's view only (like any bot). */
export function greedyMove(state: GameState, playerId: PlayerId): Move | null {
  const view = sanitizeStateForPlayer(state, playerId);
  const move = GreedyBot.choose(view, initKnowledge(view), NO_RNG);
  return move ? { ...move, playerId } : null;
}

/** The seat the engine's turn order expects to act next, or null when the game is over. */
export function actorOf(state: GameState): PlayerId | null {
  const idx = canonicalActor(state);
  return idx === -1 ? null : state.players[idx]!.id;
}

/** Plays GreedyBot for every seat (engine turn order) until `until` holds. Deterministic. */
export function fastForward(state: GameState, until: (s: GameState) => boolean, maxMoves = 500): GameState {
  for (let i = 0; i < maxMoves && !until(state); i++) {
    const actor = actorOf(state);
    const move = actor === null ? null : greedyMove(state, actor);
    if (!move) break;
    state = mustApply(state, move);
  }
  if (!until(state)) throw new Error('tutorial fast-forward did not reach its position');
  return state;
}
