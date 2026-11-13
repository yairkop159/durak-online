import type { Card, Suit } from './cards.js';
import type { GameConfig } from './config.js';
import type { PlayerId, TablePair } from './moves.js';

/**
 * Phases of a game. `bout` covers both the "defending" and the "defender is taking" sub-states;
 * `passed` lists the non-defenders who declared they are done throwing in since the table last changed.
 */
export type GamePhase =
  | { readonly kind: 'awaitingAttack' }
  | {
      readonly kind: 'bout';
      readonly taking: boolean;
      readonly passed: readonly PlayerId[];
    }
  | { readonly kind: 'finished'; readonly durak: PlayerId | null };

/**
 * Public summary of the most recently resolved bout: the final table (including a closing
 * defense or throw-in that never appeared on its own), how it ended and who defended.
 * Kept until the next bout resolves.
 */
export interface BoutSummary {
  readonly table: readonly TablePair[];
  readonly outcome: 'beaten' | 'taken';
  readonly defenderId: PlayerId;
}

export interface PublicPlayer {
  readonly id: PlayerId;
  readonly handCount: number;
  readonly finished: boolean;
}

/**
 * What a single player is allowed to see. Produced only by the engine's
 * `sanitizeStateForPlayer`; contains no opponent cards and no deck order.
 */
export interface PlayerView {
  /** `null` for a spectator view (no hand revealed). */
  readonly viewerId: PlayerId | null;
  readonly hand: readonly Card[];
  readonly players: readonly PublicPlayer[];
  readonly deckCount: number;
  readonly trumpCard: Card;
  readonly trumpSuit: Suit;
  readonly discardCount: number;
  readonly table: readonly TablePair[];
  readonly attackerId: PlayerId;
  readonly defenderId: PlayerId;
  readonly phase: GamePhase;
  readonly boutNumber: number;
  readonly finishOrder: readonly PlayerId[];
  readonly config: GameConfig;
  /** The last resolved bout (public), or `null` before the first one ends. */
  readonly lastBout: BoutSummary | null;
}
