import type { ClientToServerEvents, ServerToClientEvents } from '@durak/shared';
import type { Server, Socket } from 'socket.io';
import type { Session } from '../domain/types.js';

export interface SocketData {
  /** Set once the connection has created, joined or resumed a room. */
  session: Session | null;
}

type InterServerEvents = Record<string, never>;

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Socket.io rooms ("channels") used for fan-out. */
export const channels = {
  room: (roomId: string) => `room:${roomId}`,
  player: (playerId: string) => `player:${playerId}`,
  spectators: (roomId: string) => `spectators:${roomId}`,
  spectator: (spectatorId: string) => `spectator:${spectatorId}`,
} as const;
