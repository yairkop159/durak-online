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
  assertDistinct(players, 'eloDeltas');
  const raw = new Map<string, number>(players.map((p) => [p.profileId, 0]));
  if (players.length < 2) return raw;
  const kPair = k / (players.length - 1);
  for (const loser of players) {
    if (!loser.lost) continue;
    for (const winner of players) {
      if (winner.lost) continue;
      applyMatch(raw, kPair, winner, loser);
    }
  }
  return roundDeltas(raw);
}

function assertDistinct(players: readonly { readonly profileId: string }[], name: string): void {
  const ids = new Set(players.map((p) => p.profileId));
  if (ids.size !== players.length) throw new Error(`${name}: a profile appears more than once`);
}

type Rated = { readonly profileId: string; readonly rating: number };

/** One match the loser lost: the winner gains what the loser loses (zero-sum). */
function applyMatch(raw: Map<string, number>, kPair: number, winner: Rated, loser: Rated): void {
  const gain = kPair * (1 - expectedScore(winner.rating, loser.rating));
  raw.set(winner.profileId, (raw.get(winner.profileId) ?? 0) + gain);
  raw.set(loser.profileId, (raw.get(loser.profileId) ?? 0) - gain);
}

/** One loss charged to `loser` against `opponent`, with nobody credited (see teamEloDeltas). */
function applyPenalty(raw: Map<string, number>, kPair: number, opponent: Rated, loser: Rated): void {
  const loss = kPair * (1 - expectedScore(opponent.rating, loser.rating));
  raw.set(loser.profileId, (raw.get(loser.profileId) ?? 0) - loss);
}

function roundDeltas(raw: ReadonlyMap<string, number>): Map<string, number> {
  const rounded = new Map<string, number>();
  // `+ 0` turns a -0 from Math.round(-0.4) into 0.
  for (const [id, delta] of raw) rounded.set(id, Math.round(delta) + 0);
  return rounded;
}

/** One rated human in a finished 2v2 team game. */
export interface TeamEloPlayer {
  readonly profileId: string;
  readonly rating: number;
  readonly team: 0 | 1;
  /** Left the game or their reconnection grace expired. */
  readonly forfeited: boolean;
}

/**
 * Pairwise ELO for a 2v2 team game. Only players on opposite teams are paired; partners never are.
 * Each (x, y) cross-team pair is decided in this order:
 * 1. exactly one of them forfeited → the forfeiter loses to the other (a normal, zero-sum match),
 *    WHATEVER the team result: leaving is never free, even when your team goes on to win;
 * 2. both forfeited → each is charged a loss against the other and nobody gains (the only
 *    non-zero-sum case: two deserters cannot earn points from each other);
 * 3. otherwise the team result: the member of `losingTeam` loses. A draw (`null`) is no match.
 * `kPair = K / n` for n = the larger team's number of rated players (2 in a rated 2v2 game, so a
 * player's total swing stays within about K, as in eloDeltas). Expected scores use the ratings from
 * before the game; each sum is rounded once.
 * Guarantee: a forfeiter with at least one rated opponent always loses at least 1 point (a tiny
 * loss against much stronger opponents is not rounded away to 0).
 */
export function teamEloDeltas(
  players: readonly TeamEloPlayer[],
  losingTeam: 0 | 1 | null,
  k: number = RATING_K,
): Map<string, number> {
  assertDistinct(players, 'teamEloDeltas');
  const raw = new Map<string, number>(players.map((p) => [p.profileId, 0]));
  const team = (t: 0 | 1) => players.filter((p) => p.team === t);
  const kPair = k / Math.max(1, team(0).length, team(1).length);
  const matched = new Set<string>();
  for (const x of team(0)) {
    for (const y of team(1)) {
      matched.add(x.profileId).add(y.profileId);
      if (x.forfeited && y.forfeited) {
        applyPenalty(raw, kPair, y, x);
        applyPenalty(raw, kPair, x, y);
      } else if (x.forfeited) applyMatch(raw, kPair, y, x);
      else if (y.forfeited) applyMatch(raw, kPair, x, y);
      else if (losingTeam === 0) applyMatch(raw, kPair, y, x);
      else if (losingTeam === 1) applyMatch(raw, kPair, x, y);
    }
  }
  const rounded = roundDeltas(raw);
  for (const p of players) {
    if (p.forfeited && matched.has(p.profileId)) rounded.set(p.profileId, Math.min(rounded.get(p.profileId) ?? 0, -1));
  }
  return rounded;
}
