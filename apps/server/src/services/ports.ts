import type { ReactionPayload, RestartVoteEndedPayload } from '@durak/shared';
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
  /** A restart vote ended (passed, declined, expired or cancelled); sent to the whole room. */
  restartVoteEnded(room: Room, ended: Omit<RestartVoteEndedPayload, 'roomId'>): void;
  /** A quick reaction (ephemeral); sent to the whole room, spectators included. */
  reaction(room: Room, reaction: Omit<ReactionPayload, 'roomId'>): void;
  /** Send the current view to a single participant only (resync / resume). */
  sendGameStateTo(room: Room, game: StoredGame, viewer: Session): void;
}

/**
 * Told about every committed game change (and about re-arms: startup, resume), inside the room lock,
 * after the broadcast. `prev` is the state before the change, or null when there was no move
 * (start, resume, startup). The BotDriver and the ReactionService implement this.
 */
export interface GameChangeListener {
  onGameChanged(room: Room, game: StoredGame, prev: StoredGame['state'] | null, info?: GameChangeInfo): void;
}

export interface GameChangeInfo {
  /** The bots-only fast-forward played the rest of the game inside this commit. */
  readonly fastForwarded: boolean;
}

/**
 * Called by a service, inside the room lock, as soon as a session is established for the
 * calling connection — before any broadcast, so the caller never misses its own update.
 */
export type SessionBinder = (session: Session) => void;
