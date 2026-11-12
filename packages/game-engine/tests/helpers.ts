import {
  DEFAULT_GAME_CONFIG,
  sameCard,
  type Card,
  type GameConfig,
  type GamePhase,
  type Move,
  type Rank,
  type Suit,
  type TablePair,
} from '@durak/shared';
import { expect } from 'vitest';
import { applyMove, createDeck, type GameState } from '../src/index.js';

const RANK_BY_LABEL: Record<string, Rank> = {
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Parses "6S", "10H", "QD", "AC" into a Card. */
export function c(label: string): Card {
  const suit = label.slice(-1) as Suit;
  const rank = RANK_BY_LABEL[label.slice(0, -1)];
  if (rank === undefined || !['S', 'C', 'D', 'H'].includes(suit)) {
    throw new Error(`Bad card label ${label}`);
  }
  return { suit, rank };
}

export function cards(labels: string): Card[] {
  return labels.trim() === '' ? [] : labels.trim().split(/\s+/).map(c);
}

export interface StateSpec {
  hands: Record<string, string>;
  deck?: string;
  trump?: string;
  discard?: string;
  table?: [string, string | null][];
  attacker?: string;
  defender?: string;
  phase?: GamePhase;
  boutNumber?: number;
  finishOrder?: string[];
  config?: Partial<GameConfig>;
}

/**
 * Builds a GameState by hand. Card conservation is NOT enforced here, so tests
 * can describe a mid-game position with only the cards that matter.
 */
export function makeState(spec: StateSpec): GameState {
  const ids = Object.keys(spec.hands);
  const deck = cards(spec.deck ?? '');
  const trumpCard = spec.trump ? c(spec.trump) : (deck[deck.length - 1] ?? c('6H'));
  const attacker = spec.attacker ?? ids[0]!;
  const attackerIndex = ids.indexOf(attacker);
  const defenderIndex = spec.defender ? ids.indexOf(spec.defender) : (attackerIndex + 1) % ids.length;
  const table: TablePair[] = (spec.table ?? []).map(([a, d]) => ({
    attack: c(a),
    defense: d === null ? null : c(d),
  }));
  return {
    config: { ...DEFAULT_GAME_CONFIG, ...spec.config },
    players: ids.map((id) => ({ id, hand: cards(spec.hands[id]!) })),
    deck,
    trumpCard,
    discard: cards(spec.discard ?? ''),
    table,
    attackerIndex,
    defenderIndex,
    phase:
      spec.phase ?? (table.length > 0 ? { kind: 'bout', taking: false, passed: [] } : { kind: 'awaitingAttack' }),
    boutNumber: spec.boutNumber ?? 2,
    finishOrder: spec.finishOrder ?? [],
  };
}

/** Applies a move and asserts it succeeds. */
export function play(state: GameState, move: Move): GameState {
  const result = applyMove(state, move);
  if (!result.ok) {
    throw new Error(`Expected ${JSON.stringify(move)} to succeed, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Applies a sequence of moves, asserting each succeeds. */
export function playAll(state: GameState, moves: Move[]): GameState {
  return moves.reduce(play, state);
}

/** Asserts a move fails with the given error code. */
export function expectError(state: GameState, move: Move, code: string): void {
  const result = applyMove(state, move);
  expect(result.ok, `expected ${JSON.stringify(move)} to fail with ${code}`).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

export function handOf(state: GameState, id: string): readonly Card[] {
  const player = state.players.find((p) => p.id === id);
  if (!player) throw new Error(`No player ${id}`);
  return player.hand;
}

export function idOf(state: GameState, index: number): string {
  return state.players[index]!.id;
}

/** Every card currently in the game (hands, deck, table, discard). */
export function allCards(state: GameState): Card[] {
  return [
    ...state.players.flatMap((p) => p.hand),
    ...state.deck,
    ...state.discard,
    ...state.table.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack])),
  ];
}

export function isFullDeckPermutation(list: readonly Card[]): boolean {
  const reference = createDeck();
  return list.length === reference.length && reference.every((card) => list.filter((x) => sameCard(x, card)).length === 1);
}

/** Builds a full 36-card deck whose first cards are `top` (in order) and whose last card is `bottom`. */
export function stackedDeck(top: string, bottom: string): Card[] {
  const head = cards(top);
  const trump = c(bottom);
  const rest = createDeck().filter((x) => !sameCard(x, trump) && !head.some((h) => sameCard(h, x)));
  return [...head, ...rest, trump];
}
