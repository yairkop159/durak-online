import { useEffect, useState } from 'react';
import type { ClientGame } from './store';

type DeadlineInfo = Pick<ClientGame, 'turnDeadline' | 'serverTime' | 'receivedAt'>;

/**
 * Milliseconds left on the turn timer, or null when no timer runs.
 * `turnDeadline - serverTime` is the time left when the server sent the payload (both server clock);
 * subtracting the local time elapsed since we received it avoids comparing two different clocks.
 */
export function remainingMs(game: DeadlineInfo, now: number): number | null {
  if (game.turnDeadline === null) return null;
  return Math.max(0, game.turnDeadline - game.serverTime - (now - game.receivedAt));
}

/** Whole seconds shown to the user (rounded up, so "1" shows until the very end). */
export function secondsLeft(ms: number): number {
  return Math.ceil(ms / 1000);
}

/**
 * Re-renders every `intervalMs` while a deadline is running. `clock` must be the same clock that
 * stamped `receivedAt` (the client's).
 */
export function useCountdown(game: DeadlineInfo | null, clock: () => number, intervalMs = 250): number | null {
  const [now, setNow] = useState(clock);
  const running = game !== null && game.turnDeadline !== null;
  useEffect(() => {
    if (!running) return;
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(timer);
  }, [running, clock, intervalMs, game?.turnDeadline, game?.receivedAt]);
  return game ? remainingMs(game, now) : null;
}
