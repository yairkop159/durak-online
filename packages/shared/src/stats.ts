import type { PlayerId } from './moves.js';

/**
 * End-of-game statistics for one player. Collected by the server from public information only
 * (cards that went face-up on the table, and bout resolutions), sent in `game:over`.
 */
export interface PlayerStats {
  /** Bouts this player opened as the main attacker. */
  readonly boutsAttacked: number;
  /** Bouts that resolved with this player defending. */
  readonly boutsDefended: number;
  /** ...of which beaten (successful defenses). `defenses + takes = boutsDefended`. */
  readonly defenses: number;
  /** Bouts this player picked up. */
  readonly takes: number;
  /** Table cards this player picked up. */
  readonly cardsTaken: number;
  /** Attack cards added after the opening card (by anyone but the defender). */
  readonly throwIns: number;
  readonly transfers: number;
  /** Every card this player put on the table (opening, throw-in, defense, transfer). */
  readonly cardsPlayed: number;
}

export type GameStats = Readonly<Record<PlayerId, PlayerStats>>;

export const STAT_KEYS = [
  'boutsAttacked',
  'boutsDefended',
  'defenses',
  'takes',
  'cardsTaken',
  'throwIns',
  'transfers',
  'cardsPlayed',
] as const satisfies readonly (keyof PlayerStats)[];

export const EMPTY_PLAYER_STATS: PlayerStats = {
  boutsAttacked: 0,
  boutsDefended: 0,
  defenses: 0,
  takes: 0,
  cardsTaken: 0,
  throwIns: 0,
  transfers: 0,
  cardsPlayed: 0,
};
