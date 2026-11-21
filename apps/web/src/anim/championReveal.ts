import type { TournamentView } from '@durak/shared';

/**
 * The champion moment at the end of a tournament (pure planning; ChampionReveal renders it). It
 * follows the last game's durak reveal, in the same style:
 *   1. dim       — the table darkens again
 *   2. spotlight — a light settles on each champion's seat
 *   3. stamp     — "אלוף הטורניר!" with the champion line and the win stinger
 * Then the game-over overlay opens with the final table. None for a series that ended early (no
 * champion) or under reduced motion (the overlay shows the champion line and the 🏆 row instead).
 */
export interface ChampionPlan {
  /** Seats behind the champion rows (one seat, both partners, or co-champions). */
  readonly seats: readonly string[];
  readonly dimMs: number;
  readonly spotMs: number;
  readonly stampMs: number;
  readonly stampAtMs: number;
  readonly totalMs: number;
}

export const CHAMPION_BASE = { dimMs: 300, spotMs: 700, stampMs: 1600 } as const;

export function planChampionReveal(
  tournament: TournamentView | null,
  options: { readonly reduced: boolean; readonly speed: number },
): ChampionPlan | null {
  if (!tournament || tournament.status !== 'finished' || tournament.champions.length === 0 || options.reduced) return null;
  const seats = tournament.standings.filter((r) => tournament.champions.includes(r.key)).flatMap((r) => r.playerIds);
  const scale = (ms: number) => Math.round(ms * options.speed);
  const dimMs = scale(CHAMPION_BASE.dimMs);
  const spotMs = scale(CHAMPION_BASE.spotMs);
  const stampMs = scale(CHAMPION_BASE.stampMs);
  return { seats, dimMs, spotMs, stampMs, stampAtMs: dimMs + spotMs, totalMs: dimMs + spotMs + stampMs };
}
