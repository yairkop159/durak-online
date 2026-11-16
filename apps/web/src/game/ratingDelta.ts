import type { RatingEntry, UnratedReason } from '@durak/shared';
import type { ClientRatings } from '../net/store';

/** "Calculating rating..." stays up at most this long after the pending status arrived. */
export const RATING_PENDING_SHOW_MS = 4_000;

export type DeltaTone = 'gain' | 'loss' | 'even';

export function deltaTone(delta: number): DeltaTone {
  return delta > 0 ? 'gain' : delta < 0 ? 'loss' : 'even';
}

/** `+12`, `−8` (a real minus sign), `0`. Render it `dir="ltr"` so the sign stays in front in RTL. */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '0';
}

export type RatingDisplay =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unrated'; readonly reason: UnratedReason }
  /** `mine` is null for a spectator or an unprofiled player; `others` follow seat order. */
  | { readonly kind: 'rated'; readonly mine: RatingEntry | null; readonly others: readonly RatingEntry[] };

/**
 * What the game-over screen shows about the rating, from the received status (pure):
 * nothing without a status; "calculating" only until RATING_PENDING_SHOW_MS after it arrived
 * (a later `rated` still shows); the reason when unrated; my change and the others' when rated.
 */
export function ratingDisplay(
  ratings: ClientRatings | null,
  viewerId: string | null,
  seatOrder: readonly string[],
  now: number,
): RatingDisplay {
  if (!ratings) return { kind: 'none' };
  const p = ratings.payload;
  switch (p.status) {
    case 'pending':
      return now - ratings.receivedAt < RATING_PENDING_SHOW_MS ? { kind: 'pending' } : { kind: 'none' };
    case 'unrated':
      return { kind: 'unrated', reason: p.reason };
    case 'rated': {
      const seat = (id: string) => {
        const i = seatOrder.indexOf(id);
        return i === -1 ? seatOrder.length : i;
      };
      const mine = p.entries.find((e) => e.playerId === viewerId) ?? null;
      const others = p.entries.filter((e) => e !== mine).sort((a, b) => seat(a.playerId) - seat(b.playerId));
      return { kind: 'rated', mine, others };
    }
  }
}

/** playerId → entry, for the stats table's rating column. */
export function entriesById(ratings: ClientRatings | null): ReadonlyMap<string, RatingEntry> | null {
  return ratings?.payload.status === 'rated' ? new Map(ratings.payload.entries.map((e) => [e.playerId, e])) : null;
}
