import type { Card, GameConfig, GamePhase, PlayerId, TablePair } from '@durak/shared';

export interface PlayerState {
  readonly id: PlayerId;
  readonly hand: readonly Card[];
}

/**
 * Full authoritative game state. NEVER send this to a client:
 * use `sanitizeStateForPlayer` instead.
 */
export interface GameState {
  readonly config: GameConfig;
  /** Seating order; "clockwise" means increasing index (wrapping). */
  readonly players: readonly PlayerState[];
  /** Undealt cards. Index 0 is the top of the stock; the last element is the face-up trump card. */
  readonly deck: readonly Card[];
  /** The card that determined the trump suit (drawn last; stays publicly known). */
  readonly trumpCard: Card;
  readonly discard: readonly Card[];
  readonly table: readonly TablePair[];
  /** The bout's main attacker (leads the bout and draws first). */
  readonly attackerIndex: number;
  readonly defenderIndex: number;
  readonly phase: GamePhase;
  /** 1-based bout counter; bout 1 uses `config.firstBoutMaxCards`. */
  readonly boutNumber: number;
  /** Players who have gone out, in the order they went out. */
  readonly finishOrder: readonly PlayerId[];
}
