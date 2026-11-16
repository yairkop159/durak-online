import type { BotDifficulty, GameConfigInput, GameEndReason, GameStats, PlayerId } from '@durak/shared';
import type { GameState, PublicKnowledge } from '@durak/game-engine';

// All domain records are plain JSON so any repository (in-memory, Redis) can store them unchanged.

/**
 * A seat. Bot seats (`isBot: true`, `botDifficulty` set) are always connected, never AFK, never get a
 * grace period and have no session. Build them only with `newBotMember` (RoomService).
 */
export interface RoomMember {
  readonly playerId: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly isBot: boolean;
  /** Set for bot seats, null for humans. */
  readonly botDifficulty: BotDifficulty | null;
  /** Set after 2 consecutive turn timeouts; cleared by a human move or session:resume. */
  readonly afk: boolean;
  /** Turn timeouts in a row that applied a move for this player. Server-only. */
  readonly consecutiveTimeouts: number;
  /** Epoch ms when an offline player forfeits, or null. Server-only. */
  readonly graceDeadline: number | null;
  /**
   * The human who held this seat left the running game (or their reconnection grace expired).
   * With a bot takeover the seat is also `isBot: true` (medium) for the rest of the game.
   * A rematch removes these seats.
   */
  readonly leftGame: boolean;
  /**
   * The profile this human sat down with (Phase 10, resolved from the device key on create/join),
   * or null. Server-only (never in room:state). A profile holds at most one seat per room.
   */
  readonly profileId: string | null;
}

export interface Spectator {
  readonly spectatorId: string;
  readonly nickname: string;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

/** An open "new game" vote (Phase 7). Bots and offline/AFK humans are not voters. */
export interface RestartVote {
  readonly voteId: string;
  readonly proposerId: PlayerId;
  readonly expiresAt: number;
  /** Who must accept (the other connected, non-AFK humans when it opened; drops shrink it). */
  readonly voters: readonly PlayerId[];
  readonly accepted: readonly PlayerId[];
}

export interface Room {
  readonly id: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly config: GameConfigInput;
  readonly members: readonly RoomMember[];
  readonly spectators: readonly Spectator[];
  readonly status: RoomStatus;
  readonly createdAt: number;
  /** The open restart vote, or null. */
  readonly restartVote: RestartVote | null;
  /** Proposer -> epoch ms until which they may not propose again. Expired entries are pruned. */
  readonly restartCooldowns: Readonly<Record<PlayerId, number>>;
}

export type SessionRole = 'player' | 'spectator';

export interface Session {
  readonly token: string;
  readonly roomId: string;
  readonly role: SessionRole;
  /** playerId for players, spectatorId for spectators. Server-generated, never client-supplied. */
  readonly id: string;
}

export interface StoredGame {
  readonly roomId: string;
  /** A new id for every game dealt in the room (clients replace their game when it changes). */
  readonly gameId: string;
  /** Shuffle seed, kept for replay and debugging. */
  readonly seed: number;
  /** Incremented on every successful move; clients echo it back as `expectedVersion`. */
  readonly version: number;
  readonly state: GameState;
  readonly startedAt: number;
  /** Epoch ms when the current turn times out; null once the game is over. Survives restarts. */
  readonly turnDeadline: number | null;
  /** Consecutive timer expiries with no human move in between (abandon guard). */
  readonly timeoutStreak: number;
  /** Set when the game ends. */
  readonly endReason: GameEndReason | null;
  /**
   * What each seated player can prove about hidden cards, built only from their own views and
   * advanced on every version (GameCommitter). Bots (and the AFK takeover) decide from it.
   * A missing entry is rebuilt with `initKnowledge`, which is always sound.
   */
  readonly knowledge: Readonly<Record<PlayerId, PublicKnowledge>>;
  /** Human seats a bot ever played for (AFK or leave takeover); for ratings (Phase 3d). */
  readonly botAssisted: readonly PlayerId[];
  /**
   * Humans who left this game or whose reconnection grace expired, in order. Each one is a loss
   * for ratings, whether the game then ended (forfeit) or a bot finished it for them.
   */
  readonly forfeits: readonly PlayerId[];
  /**
   * Per-player end-of-game statistics (public information only), advanced on every commit
   * (GameCommitter) and sent in game:over.
   */
  readonly stats: GameStats;
  /**
   * Profiled human seats when the game was dealt (playerId → profileId; Phase 10). Bots never
   * appear. The match history and ratings use this snapshot, whatever happens to the room later.
   */
  readonly profiles: Readonly<Record<PlayerId, string>>;
}
