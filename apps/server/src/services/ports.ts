import type { Room, Session, StoredGame } from '../domain/types.js';

/**
 * Outbound port: services announce state changes; the transport layer decides how to
 * deliver them (and is responsible for sanitizing game state per recipient).
 * Services call these while holding the room lock, so deliveries are in version order.
 */
export interface RoomNotifier {
  roomState(room: Room): void;
  /** Send every seated player their own view, and spectators the public view. */
  gameState(room: Room, game: StoredGame): void;
  gameOver(room: Room, game: StoredGame): void;
  /** Send the current view to a single participant only (resync / resume). */
  sendGameStateTo(room: Room, game: StoredGame, viewer: Session): void;
}

/**
 * Told about every committed game change (and about re-arms: startup, resume), inside the room lock,
 * after the broadcast. `prev` is the state before the change, or null when there was no move
 * (start, resume, startup). The BotDriver implements this.
 */
export interface GameChangeListener {
  onGameChanged(room: Room, game: StoredGame, prev: StoredGame['state'] | null): void;
}

/**
 * Called by a service, inside the room lock, as soon as a session is established for the
 * calling connection — before any broadcast, so the caller never misses its own update.
 */
export type SessionBinder = (session: Session) => void;
