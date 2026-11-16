import { useEffect, useReducer } from 'react';
import { RATING_PENDING_SHOW_MS, deltaTone, formatDelta, ratingDisplay } from '../../game/ratingDelta';
import { t } from '../../i18n';
import type { ClientRatings } from '../../net/store';

const TONE_CLASS = { gain: 'text-gain', loss: 'text-loss', even: 'text-muted' } as const;

/** A coloured signed delta (`+12` green, `−8` red), kept left-to-right inside the RTL page. */
export function DeltaText({ delta, className = '' }: { delta: number; className?: string }) {
  return (
    <span dir="ltr" className={`tabular-nums ${TONE_CLASS[deltaTone(delta)]} ${className}`}>
      {formatDelta(delta)}
    </span>
  );
}

/** Re-renders once when the pending status's display time runs out. */
function usePendingExpiry(ratings: ClientRatings | null): void {
  const until = ratings?.payload.status === 'pending' ? ratings.receivedAt + RATING_PENDING_SHOW_MS : null;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (until === null) return;
    const ms = until - Date.now();
    if (ms <= 0) return;
    const id = setTimeout(tick, ms);
    return () => clearTimeout(id);
  }, [until]);
}

/**
 * The rating part of the game-over screen: my change big and coloured with the new rating, a quiet
 * "calculating..." for a few seconds, or why the game was not rated. Nothing at all without a
 * status (ratings off, Postgres down): never an error. `showOthers` lists the other rated players
 * when the stats table (which has a rating column) is not available, e.g. after a reload.
 */
export function RatingResult({
  ratings,
  viewerId,
  seatOrder,
  nameOf,
  showOthers,
}: {
  ratings: ClientRatings | null;
  viewerId: string | null;
  seatOrder: readonly string[];
  nameOf: (id: string) => string;
  showOthers: boolean;
}) {
  usePendingExpiry(ratings);
  const display = ratingDisplay(ratings, viewerId, seatOrder, Date.now());

  switch (display.kind) {
    case 'none':
      return null;
    case 'pending':
      return (
        <p role="status" className="text-xs text-muted" data-testid="rating-pending">
          {t.rating.calculating}
        </p>
      );
    case 'unrated':
      return (
        <p className="text-xs text-muted" data-testid="rating-unrated">
          {t.rating.unrated[display.reason]}
        </p>
      );
    case 'rated': {
      const { mine, others } = display;
      return (
        <>
          {mine && (
            <div role="status" className="flex flex-col items-center gap-0.5" data-testid="rating-delta">
              <span className="sr-only">{t.rating.changeLabel(mine.delta)}</span>
              <span aria-hidden="true">
                <DeltaText delta={mine.delta} className="text-4xl leading-none font-black" />
              </span>
              <span className="text-xs text-muted" data-testid="rating-new">
                {t.rating.newRating(mine.after)}
              </span>
            </div>
          )}
          {showOthers && others.length > 0 && (
            <div className="w-full" data-testid="rating-others">
              <h3 className="mb-1.5 text-sm font-semibold">{t.rating.others}</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {others.map((e) => (
                  <li key={e.playerId} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-1">
                    <span className="truncate">{nameOf(e.playerId)}</span>
                    <DeltaText delta={e.delta} className="font-bold" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
    }
  }
}
