/**
 * What happens when a seated player leaves a game (or their reconnection grace expires).
 * Shared by the server (which applies it) and the web client (which explains it in the leave dialog).
 *
 * - `none`: no running game, or the leaver already went out; nobody loses anything.
 * - `takeover`: 3+ seats and another human is still in the game -> a medium bot plays the seat
 *   and the game continues; the leaver is recorded as a loser (`forfeits`).
 * - `resign`: otherwise (2 seats, or no other human still in) -> the game ends now with the
 *   leaver as the durak (`endReason: 'forfeit'`).
 */
export type DepartureKind = 'none' | 'resign' | 'takeover';

export interface DepartureSeat {
  readonly playerId: string;
  readonly isHuman: boolean;
  /** Already went out of the game (in `finishOrder`). */
  readonly isOut: boolean;
}

export interface DepartureInput {
  /** A game is running (not finished). */
  readonly running: boolean;
  readonly leaverId: string;
  /** Every seat of the game, in seat order. */
  readonly seats: readonly DepartureSeat[];
}

export function departureKind(input: DepartureInput): DepartureKind {
  if (!input.running) return 'none';
  const leaver = input.seats.find((s) => s.playerId === input.leaverId);
  if (!leaver || leaver.isOut) return 'none';
  if (input.seats.length < 3) return 'resign';
  const otherHumanStillIn = input.seats.some((s) => s.playerId !== input.leaverId && s.isHuman && !s.isOut);
  return otherHumanStillIn ? 'takeover' : 'resign';
}
