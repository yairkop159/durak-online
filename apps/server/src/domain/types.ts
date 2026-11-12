import type { GameConfigInput } from '@durak/shared';
import type { GameState } from '@durak/game-engine';

// All domain records are plain JSON so any repository (in-memory, Redis) can store them unchanged.

export interface RoomMember {
  readonly playerId: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly isBot: false;
}

export interface Spectator {
  readonly spectatorId: string;
  readonly nickname: string;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface Room {
  readonly id: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly config: GameConfigInput;
  readonly members: readonly RoomMember[];
  readonly spectators: readonly Spectator[];
  readonly status: RoomStatus;
  readonly createdAt: number;
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
  /** Shuffle seed, kept for replay and debugging. */
  readonly seed: number;
  /** Incremented on every successful move; clients echo it back as `expectedVersion`. */
  readonly version: number;
  readonly state: GameState;
  readonly startedAt: number;
}
