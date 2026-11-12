import {
  HAND_SIZE,
  cardId,
  type Card,
  type GameError,
  type GamePhase,
  type Move,
  type PlayerId,
  type TablePair,
} from '@durak/shared';
import { beats, hasCard, removeCard } from './deck.js';
import { err, gameError, ok, type Result } from './result.js';
import type { GameState, PlayerState } from './state.js';

type BoutPhase = Extract<GamePhase, { kind: 'bout' }>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function playerIndex(state: GameState, playerId: PlayerId): number {
  return state.players.findIndex((p) => p.id === playerId);
}

export function isFinished(state: GameState, index: number): boolean {
  const player = state.players[index];
  return player === undefined || state.finishOrder.includes(player.id);
}

/** Next seat clockwise from `from` (exclusive) that is still in the game. Returns `from` if none. */
export function nextActiveIndex(state: GameState, from: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!isFinished(state, idx)) return idx;
  }
  return from;
}

/** Maximum number of attack cards allowed on the table in the current bout. */
export function boutCardLimit(state: GameState): number {
  return state.boutNumber === 1 ? state.config.firstBoutMaxCards : state.config.boutMaxCards;
}

function hand(state: GameState, index: number): readonly Card[] {
  return state.players[index]?.hand ?? [];
}

function uncoveredCount(table: readonly TablePair[]): number {
  return table.filter((p) => p.defense === null).length;
}

function tableRanks(table: readonly TablePair[]): Set<number> {
  const ranks = new Set<number>();
  for (const pair of table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

/** Whether one more attack card may be added for the current defender. */
function hasRoomForAttack(state: GameState): boolean {
  return (
    state.table.length < boutCardLimit(state) &&
    uncoveredCount(state.table) < hand(state, state.defenderIndex).length
  );
}

/** Whether the player at `index` could legally throw in some card right now. */
export function canThrowIn(state: GameState, index: number): boolean {
  if (state.phase.kind !== 'bout' || index === state.defenderIndex || isFinished(state, index)) {
    return false;
  }
  if (!hasRoomForAttack(state)) return false;
  const ranks = tableRanks(state.table);
  return hand(state, index).some((c) => ranks.has(c.rank));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns `null` if the move is legal in `state`, otherwise the reason it is not. */
export function validateMove(state: GameState, move: Move): GameError | null {
  if (state.phase.kind === 'finished') return gameError('GAME_FINISHED', 'The game is over');
  const idx = playerIndex(state, move.playerId);
  if (idx === -1) return gameError('UNKNOWN_PLAYER', `Unknown player ${move.playerId}`);
  if (isFinished(state, idx)) return gameError('PLAYER_FINISHED', 'You are already out of the game');

  const phase = state.phase;
  const isDefender = idx === state.defenderIndex;

  switch (move.type) {
    case 'attack': {
      if (!hasCard(hand(state, idx), move.card)) {
        return gameError('CARD_NOT_IN_HAND', `You do not hold ${cardId(move.card)}`);
      }
      if (phase.kind === 'awaitingAttack') {
        if (idx !== state.attackerIndex) return gameError('NOT_YOUR_TURN', 'Only the attacker may open the bout');
        return null;
      }
      if (isDefender) return gameError('NOT_YOUR_TURN', 'The defender cannot throw in');
      if (!tableRanks(state.table).has(move.card.rank)) {
        return gameError('RANK_NOT_ON_TABLE', 'Thrown-in cards must match a rank already on the table');
      }
      if (!hasRoomForAttack(state)) {
        return gameError('TABLE_LIMIT_REACHED', 'No more cards may be thrown in this bout');
      }
      return null;
    }

    case 'defend': {
      if (phase.kind !== 'bout') return gameError('INVALID_MOVE', 'There is nothing to defend against');
      if (!isDefender) return gameError('NOT_YOUR_TURN', 'Only the defender may defend');
      if (phase.taking) return gameError('INVALID_MOVE', 'You already chose to take the cards');
      const pair = state.table[move.attackIndex];
      if (pair === undefined) return gameError('INVALID_ATTACK_INDEX', 'No attack card at that position');
      if (pair.defense !== null) return gameError('ALREADY_COVERED', 'That card is already covered');
      if (!hasCard(hand(state, idx), move.card)) {
        return gameError('CARD_NOT_IN_HAND', `You do not hold ${cardId(move.card)}`);
      }
      if (!beats(pair.attack, move.card, state.trumpCard.suit)) {
        return gameError(
          'CARD_DOES_NOT_BEAT',
          `${cardId(move.card)} does not beat ${cardId(pair.attack)}`,
        );
      }
      return null;
    }

    case 'transfer': {
      if (state.config.mode !== 'perevodnoy') {
        return gameError('TRANSFER_NOT_ALLOWED', 'Transfers are only allowed in perevodnoy mode');
      }
      if (phase.kind !== 'bout') return gameError('INVALID_MOVE', 'There is nothing to transfer');
      if (!isDefender) return gameError('NOT_YOUR_TURN', 'Only the defender may transfer');
      if (phase.taking) return gameError('INVALID_MOVE', 'You already chose to take the cards');
      if (!hasCard(hand(state, idx), move.card)) {
        return gameError('CARD_NOT_IN_HAND', `You do not hold ${cardId(move.card)}`);
      }
      if (state.table.some((p) => p.defense !== null)) {
        return gameError('TRANSFER_NOT_ALLOWED', 'Cannot transfer after a card has been covered');
      }
      if (state.table.some((p) => p.attack.rank !== move.card.rank)) {
        return gameError('TRANSFER_NOT_ALLOWED', 'Transfer card must match the rank of every attack card');
      }
      const next = nextActiveIndex(state, idx);
      const newCount = state.table.length + 1;
      if (next === idx) return gameError('TRANSFER_NOT_ALLOWED', 'Nobody to transfer to');
      if (newCount > boutCardLimit(state)) {
        return gameError('TRANSFER_NOT_ALLOWED', 'Transfer would exceed the bout card limit');
      }
      if (newCount > hand(state, next).length) {
        return gameError('TRANSFER_NOT_ALLOWED', 'The next player does not hold enough cards');
      }
      return null;
    }

    case 'take': {
      if (phase.kind !== 'bout') return gameError('INVALID_MOVE', 'There is nothing to take');
      if (!isDefender) return gameError('NOT_YOUR_TURN', 'Only the defender may take');
      if (phase.taking) return gameError('INVALID_MOVE', 'You already chose to take the cards');
      if (uncoveredCount(state.table) === 0) {
        return gameError('INVALID_MOVE', 'All cards are covered; nothing forces you to take');
      }
      return null;
    }

    case 'pass': {
      if (phase.kind !== 'bout') return gameError('INVALID_MOVE', 'The attacker must open the bout');
      if (isDefender) return gameError('NOT_YOUR_TURN', 'The defender cannot pass; defend or take');
      if (phase.passed.includes(move.playerId)) return gameError('ALREADY_PASSED', 'You already passed');
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Pure state transition. Never mutates `state`. */
export function applyMove(state: GameState, move: Move): Result<GameState, GameError> {
  const error = validateMove(state, move);
  if (error) return err(error);

  const idx = playerIndex(state, move.playerId);
  const freshBout: BoutPhase = {
    kind: 'bout',
    taking: state.phase.kind === 'bout' ? state.phase.taking : false,
    passed: [],
  };

  let next: GameState;
  switch (move.type) {
    case 'attack':
      next = {
        ...state,
        players: withHand(state.players, idx, removeCard(hand(state, idx), move.card)),
        table: [...state.table, { attack: move.card, defense: null }],
        phase: freshBout,
      };
      break;

    case 'defend':
      next = {
        ...state,
        players: withHand(state.players, idx, removeCard(hand(state, idx), move.card)),
        table: state.table.map((pair, i) =>
          i === move.attackIndex ? { attack: pair.attack, defense: move.card } : pair,
        ),
        phase: freshBout,
      };
      break;

    case 'transfer':
      next = {
        ...state,
        players: withHand(state.players, idx, removeCard(hand(state, idx), move.card)),
        table: [...state.table, { attack: move.card, defense: null }],
        attackerIndex: idx,
        defenderIndex: nextActiveIndex(state, idx),
        phase: { kind: 'bout', taking: false, passed: [] },
      };
      break;

    case 'take':
      next = { ...state, phase: { kind: 'bout', taking: true, passed: [] } };
      break;

    case 'pass': {
      const phase = state.phase as BoutPhase;
      next = { ...state, phase: { ...phase, passed: [...phase.passed, move.playerId] } };
      break;
    }
  }

  return ok(maybeEndBout(next));
}

function withHand(
  players: readonly PlayerState[],
  index: number,
  newHand: readonly Card[],
): PlayerState[] {
  return players.map((p, i) => (i === index ? { id: p.id, hand: newHand } : p));
}

/** Ends the bout once nothing more can happen on the table. */
function maybeEndBout(state: GameState): GameState {
  const phase = state.phase;
  if (phase.kind !== 'bout') return state;
  const allCovered = state.table.every((p) => p.defense !== null);
  if (!phase.taking && !allCovered) return state;

  for (let i = 0; i < state.players.length; i++) {
    if (i === state.defenderIndex || isFinished(state, i)) continue;
    const id = state.players[i]?.id as PlayerId;
    if (!phase.passed.includes(id) && canThrowIn(state, i)) return state;
  }
  return endBout(state, phase.taking ? 'taken' : 'beaten');
}

/** Players in draw order: main attacker, the others clockwise, defender last. */
export function drawOrder(state: GameState): number[] {
  const n = state.players.length;
  const order: number[] = [];
  for (let step = 0; step < n; step++) {
    const idx = (state.attackerIndex + step) % n;
    if (idx !== state.defenderIndex && !isFinished(state, idx)) order.push(idx);
  }
  if (!isFinished(state, state.defenderIndex)) order.push(state.defenderIndex);
  return order;
}

function endBout(state: GameState, outcome: 'beaten' | 'taken'): GameState {
  const tableCards = state.table.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack]));
  const hands: Card[][] = state.players.map((p) => p.hand.slice());
  let discard = state.discard;
  if (outcome === 'beaten') {
    discard = [...discard, ...tableCards];
  } else {
    hands[state.defenderIndex]?.push(...tableCards);
  }

  // Replenish hands to six, in draw order.
  const deck = state.deck.slice();
  for (const idx of drawOrder(state)) {
    const h = hands[idx] as Card[];
    while (h.length < HAND_SIZE && deck.length > 0) {
      h.push(deck.shift() as Card);
    }
  }

  // Anyone with no cards once the stock is exhausted leaves the game.
  const finishOrder = [...state.finishOrder];
  if (deck.length === 0) {
    const n = state.players.length;
    for (let step = 0; step < n; step++) {
      const idx = (state.attackerIndex + step) % n;
      const player = state.players[idx] as PlayerState;
      if ((hands[idx] as Card[]).length === 0 && !finishOrder.includes(player.id)) {
        finishOrder.push(player.id);
      }
    }
  }

  const base: GameState = {
    ...state,
    players: state.players.map((p, i) => ({ id: p.id, hand: hands[i] as Card[] })),
    deck,
    discard,
    table: [],
    finishOrder,
  };

  const remaining = base.players.filter((p) => !finishOrder.includes(p.id));
  if (remaining.length <= 1) {
    return { ...base, phase: { kind: 'finished', durak: remaining[0]?.id ?? null } };
  }

  const attackerIndex =
    outcome === 'beaten' && !isFinished(base, state.defenderIndex)
      ? state.defenderIndex
      : nextActiveIndex(base, state.defenderIndex);
  return {
    ...base,
    attackerIndex,
    defenderIndex: nextActiveIndex(base, attackerIndex),
    phase: { kind: 'awaitingAttack' },
    boutNumber: state.boutNumber + 1,
  };
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

/** Every legal move for `playerId` in `state` (empty if the player cannot act). */
export function getLegalMoves(state: GameState, playerId: PlayerId): Move[] {
  const idx = playerIndex(state, playerId);
  if (idx === -1 || state.phase.kind === 'finished' || isFinished(state, idx)) return [];
  const candidates: Move[] = [];
  const cards = hand(state, idx);

  for (const card of cards) candidates.push({ type: 'attack', playerId, card });
  if (state.phase.kind === 'bout') {
    if (idx === state.defenderIndex) {
      state.table.forEach((pair, attackIndex) => {
        if (pair.defense !== null) return;
        for (const card of cards) candidates.push({ type: 'defend', playerId, attackIndex, card });
      });
      for (const card of cards) candidates.push({ type: 'transfer', playerId, card });
      candidates.push({ type: 'take', playerId });
    } else {
      candidates.push({ type: 'pass', playerId });
    }
  }
  return candidates.filter((m) => validateMove(state, m) === null);
}

/** Ids of the players who currently have at least one legal move. */
export function getPlayersToAct(state: GameState): PlayerId[] {
  return state.players.filter((p) => getLegalMoves(state, p.id).length > 0).map((p) => p.id);
}
