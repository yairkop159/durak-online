import {
  DECK_SIZE,
  DEFAULT_GAME_CONFIG,
  GameConfigSchema,
  HAND_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SUITS,
  sameCard,
  type Card,
  type GameConfigInput,
  type GameError,
  type PlayerId,
} from '@durak/shared';
import { createDeck } from './deck.js';
import { err, gameError, ok, type Result } from './result.js';
import { createRng, shuffle } from './rng.js';
import type { GameState } from './state.js';

export interface CreateGameOptions {
  readonly playerIds: readonly PlayerId[];
  /** 32-bit seed for the deck shuffle. Same seed + same players => identical game. */
  readonly seed: number;
  readonly config?: GameConfigInput;
}

export function createGame(options: CreateGameOptions): Result<GameState, GameError> {
  const deck = shuffle(createDeck(), createRng(options.seed));
  return createGameWithDeck(options.playerIds, deck, options.config);
}

/**
 * Creates a game from an explicit deck order (index 0 = top; last card = trump).
 * Cards are dealt one at a time, round-robin, starting with seat 0.
 * Useful for replays and for deterministic tests.
 */
export function createGameWithDeck(
  playerIds: readonly PlayerId[],
  deck: readonly Card[],
  configInput: GameConfigInput = {},
): Result<GameState, GameError> {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    return err(
      gameError(
        'INVALID_PLAYER_COUNT',
        `Durak needs ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${playerIds.length}`,
      ),
    );
  }
  if (playerIds.some((id) => id.length === 0) || new Set(playerIds).size !== playerIds.length) {
    return err(gameError('DUPLICATE_PLAYER', 'Player ids must be unique and non-empty'));
  }
  const parsedConfig = GameConfigSchema.safeParse({ ...DEFAULT_GAME_CONFIG, ...configInput });
  if (!parsedConfig.success) {
    return err(gameError('INVALID_CONFIG', parsedConfig.error.message));
  }
  if (!isFullDeck(deck)) {
    return err(gameError('INVALID_CONFIG', `Deck must contain each of the ${DECK_SIZE} cards exactly once`));
  }

  const trumpCard = deck[deck.length - 1] as Card;
  const hands: Card[][] = playerIds.map(() => []);
  let cursor = 0;
  for (let round = 0; round < HAND_SIZE; round++) {
    for (const hand of hands) {
      hand.push(deck[cursor++] as Card);
    }
  }

  const attackerIndex = chooseFirstAttacker(hands, trumpCard.suit);
  const defenderIndex = (attackerIndex + 1) % playerIds.length;

  return ok({
    config: parsedConfig.data,
    players: playerIds.map((id, i) => ({ id, hand: hands[i] as Card[] })),
    deck: deck.slice(cursor),
    trumpCard,
    discard: [],
    table: [],
    attackerIndex,
    defenderIndex,
    phase: { kind: 'awaitingAttack' },
    boutNumber: 1,
    finishOrder: [],
    lastBout: null,
  });
}

/**
 * The player holding the lowest trump attacks first.
 * Tie-breaker when nobody holds a trump: the lowest-ranked card overall,
 * ties between equal ranks broken by suit order (S, C, D, H).
 */
export function chooseFirstAttacker(hands: readonly (readonly Card[])[], trump: Card['suit']): number {
  let trumpIndex = -1;
  let trumpRank = Number.POSITIVE_INFINITY;
  let lowestIndex = 0;
  let lowestKey = Number.POSITIVE_INFINITY;
  hands.forEach((hand, index) => {
    for (const card of hand) {
      if (card.suit === trump && card.rank < trumpRank) {
        trumpRank = card.rank;
        trumpIndex = index;
      }
      const key = card.rank * SUITS.length + SUITS.indexOf(card.suit);
      if (key < lowestKey) {
        lowestKey = key;
        lowestIndex = index;
      }
    }
  });
  return trumpIndex !== -1 ? trumpIndex : lowestIndex;
}

function isFullDeck(deck: readonly Card[]): boolean {
  if (deck.length !== DECK_SIZE) return false;
  const reference = createDeck();
  return reference.every((card) => deck.filter((d) => sameCard(d, card)).length === 1);
}
