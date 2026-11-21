import type { Card, ClientMove, DepartureKind, GameOverPayload, RoomMember, RoomStatePayload } from '@durak/shared';
import type { ReactNode } from 'react';
import type { CardState } from '../../components/cards/PlayingCard';
import type { ClientError, ClientGame, ClientRatings } from '../../net/store';
import type { ReactionsInView } from '../../reactions/useReactions';

/**
 * What drives the game table: the socket client (`OnlineTable`, a real room) or a local driver
 * (the tutorial). `TableScreen` reads only this, so both share the same table components.
 */
export interface TableSource {
  readonly game: ClientGame | null;
  /** Seat names and badges (bot pill, AFK, left). */
  readonly members: readonly RoomMember[] | undefined;
  /** The room (online only): restart vote, status. */
  readonly room: RoomStatePayload | null;
  readonly gameOver: GameOverPayload | null;
  readonly ratings: ClientRatings | null;
  /** The last error (a rejected game move shakes the hand). */
  readonly lastError: ClientError | null;
  /** Moves would be dropped right now (re-binding the seat): offer none. */
  readonly reconnecting: boolean;
  /** The clock that stamped `game.receivedAt` (for the countdown). Must be stable. */
  readonly now: () => number;
  readonly sendMove: (move: ClientMove) => void;
  /** "Leave": what it does to the seat (the confirm text) and how to do it. */
  readonly leave: { readonly outcome: DepartureKind; readonly run: () => void };
  /** Room-only features: quick reactions, the restart vote, the rematch. Absent = not offered. */
  readonly online?: {
    readonly reactions: ReactionsInView;
    readonly rematch: () => void;
  };
  /** A guided lesson (the tutorial): highlights, hints and feedback around the real table. */
  readonly guide?: TableGuide;
}

export interface TableGuide {
  /** The goal / hint / feedback panel (rendered where the first-game tips sit). */
  readonly panel: ReactNode;
  /** While feedback is shown the table takes no moves. */
  readonly blocked: boolean;
  /** Overrides a hand card's look (only the relevant cards highlighted, picked cards). */
  readonly handCardState?: (card: Card, base: CardState) => CardState;
  /** A hand tap the table would not turn into a move (a dimmed card, or a "pick" step). Returns true if handled. */
  readonly onHandTap?: (card: Card, playable: boolean) => boolean;
  /** Draw attention to the face-up trump under the stock. */
  readonly highlightTrump?: boolean;
  /** The game-over overlay's main action (e.g. "back to the tutorial"); replaces rematch / home. */
  readonly gameOverAction?: { readonly label: string; readonly run: () => void };
}
