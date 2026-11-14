import type { GameOverPayload, PlayerView } from '@durak/shared';

/**
 * The durak reveal at the end of a game (pure planning; DurakReveal renders it):
 *   1. dim     — the table darkens and the hand slides away
 *   2. sweep   — a drumroll while a spotlight passes over the seats
 *   3. stamp   — the spotlight stops on the durak: a "דוראק!" stamp (or "תיקו!" for a draw)
 * Then the game-over overlay opens. A forfeit skips the sweep.
 */
export type RevealKind = 'durak' | 'draw' | 'forfeit';

export interface RevealPlan {
  readonly kind: RevealKind;
  readonly durakId: string | null;
  /** Seats the spotlight passes over, in order, ending on the durak (empty for a draw/forfeit). */
  readonly sweep: readonly string[];
  readonly dimMs: number;
  readonly sweepMs: number;
  readonly stampMs: number;
  /** When the stamp lands (the stinger plays here). */
  readonly stampAtMs: number;
  readonly totalMs: number;
}

export const REVEAL_BASE = { dimMs: 400, sweepMs: 1200, stampMs: 800 } as const;

/** Which reveal a finished game gets: none for an abandoned or restarted game. */
export function revealKind(gameOver: GameOverPayload): RevealKind | null {
  if (gameOver.endReason === 'abandoned' || gameOver.endReason === 'restarted') return null;
  if (gameOver.durakId === null) return 'draw';
  return gameOver.endReason === 'forfeit' ? 'forfeit' : 'durak';
}

/**
 * The plan, or null when there is no reveal: reduced motion (straight to the overlay with a
 * static highlight), or an end without a result. `speed` scales every stage (0.6 = "fast").
 */
export function planReveal(
  gameOver: GameOverPayload,
  view: PlayerView,
  options: { readonly reduced: boolean; readonly speed: number },
): RevealPlan | null {
  const kind = revealKind(gameOver);
  if (kind === null || options.reduced) return null;
  const scale = (ms: number) => Math.round(ms * options.speed);
  const dimMs = scale(REVEAL_BASE.dimMs);
  const sweepMs = kind === 'durak' ? scale(REVEAL_BASE.sweepMs) : 0;
  const stampMs = scale(REVEAL_BASE.stampMs);
  // The spotlight passes everyone in seat order, twice around if few, and stops on the durak.
  const seats = view.players.map((p) => p.id);
  const durakId = gameOver.durakId;
  let sweep: string[] = [];
  if (kind === 'durak' && durakId !== null) {
    const start = seats.length > 0 ? (seats.indexOf(durakId) + 1) % seats.length : 0;
    const laps = seats.length <= 3 ? 2 : 1;
    for (let i = 0; i < laps * seats.length; i++) sweep.push(seats[(start + i) % seats.length]!);
    sweep = [...sweep, durakId];
  }
  return { kind, durakId, sweep, dimMs, sweepMs, stampMs, stampAtMs: dimMs + sweepMs, totalMs: dimMs + sweepMs + stampMs };
}
