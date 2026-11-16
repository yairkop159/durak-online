import { RATING_K } from '@durak/shared';

/** One rated human in a finished game. */
export interface EloPlayer {
  readonly profileId: string;
  /** Rating before the game. */
  readonly rating: number;
  /** The durak or a forfeiter. */
  readonly lost: boolean;
}

/** Probability that a player rated `a` beats one rated `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * Pairwise ELO for one game (Phase 10).
 * - Every (loser, non-loser) pair of rated humans is one match the loser lost. Loser-loser and
 *   winner-winner pairs are not matches.
 * - Each match uses K / (n - 1) for n rated humans, so a player's total swing stays within about K
 *   whatever the table size. Expected scores use the ratings from before the game.
 * - Each player's sum is rounded once. A game with no loser among the humans (a draw, or a bot
 *   was the durak) gives everyone 0.
 *
 * Throws if a profile appears twice: one profile holds at most one seat per game (RoomService),
 * and a profile must never be matched against itself.
 */
export function eloDeltas(players: readonly EloPlayer[], k: number = RATING_K): Map<string, number> {
  const ids = new Set(players.map((p) => p.profileId));
  if (ids.size !== players.length) throw new Error('eloDeltas: a profile appears more than once');
  const raw = new Map<string, number>(players.map((p) => [p.profileId, 0]));
  if (players.length < 2) return raw;
  const kPair = k / (players.length - 1);
  for (const loser of players) {
    if (!loser.lost) continue;
    for (const winner of players) {
      if (winner.lost) continue;
      const gain = kPair * (1 - expectedScore(winner.rating, loser.rating));
      raw.set(winner.profileId, (raw.get(winner.profileId) ?? 0) + gain);
      raw.set(loser.profileId, (raw.get(loser.profileId) ?? 0) - gain);
    }
  }
  const rounded = new Map<string, number>();
  // `+ 0` turns a -0 from Math.round(-0.4) into 0.
  for (const [id, delta] of raw) rounded.set(id, Math.round(delta) + 0);
  return rounded;
}
