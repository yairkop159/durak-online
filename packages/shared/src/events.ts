import { z } from 'zod';
import { GameConfigInputSchema, MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { ClientMoveSchema } from './moves.js';
import type { PlayerView } from './view.js';

/** Socket.io event names, client -> server. */
export const ClientEvents = {
  CreateRoom: 'room:create',
  JoinRoom: 'room:join',
  LeaveRoom: 'room:leave',
  StartGame: 'game:start',
  MakeMove: 'game:move',
  ResumeSession: 'session:resume',
} as const;
export type ClientEventName = (typeof ClientEvents)[keyof typeof ClientEvents];

/** Socket.io event names, server -> client. */
export const ServerEvents = {
  RoomState: 'room:state',
  GameState: 'game:state',
  GameOver: 'game:over',
  Session: 'session:issued',
  Error: 'error',
} as const;
export type ServerEventName = (typeof ServerEvents)[keyof typeof ServerEvents];

export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,32}$/, 'Invalid room id');
export const NicknameSchema = z.string().trim().min(1).max(24);
export const SessionTokenSchema = z.string().min(16).max(256);

export const CreateRoomPayloadSchema = z
  .object({
    nickname: NicknameSchema,
    maxPlayers: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    config: GameConfigInputSchema.optional(),
  })
  .strict();

export const JoinRoomPayloadSchema = z
  .object({
    roomId: RoomIdSchema,
    nickname: NicknameSchema,
  })
  .strict();

export const LeaveRoomPayloadSchema = z.object({ roomId: RoomIdSchema }).strict();

export const StartGamePayloadSchema = z.object({ roomId: RoomIdSchema }).strict();

export const MakeMovePayloadSchema = z
  .object({
    roomId: RoomIdSchema,
    move: ClientMoveSchema,
    /** State version the client acted on, so the server can reject moves made against a stale state. */
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const ResumeSessionPayloadSchema = z
  .object({
    sessionToken: SessionTokenSchema,
  })
  .strict();

/** Event name -> payload schema; the server validates every incoming event through this map. */
export const ClientEventSchemas = {
  [ClientEvents.CreateRoom]: CreateRoomPayloadSchema,
  [ClientEvents.JoinRoom]: JoinRoomPayloadSchema,
  [ClientEvents.LeaveRoom]: LeaveRoomPayloadSchema,
  [ClientEvents.StartGame]: StartGamePayloadSchema,
  [ClientEvents.MakeMove]: MakeMovePayloadSchema,
  [ClientEvents.ResumeSession]: ResumeSessionPayloadSchema,
} as const satisfies Record<ClientEventName, z.ZodTypeAny>;

export type CreateRoomPayload = z.infer<typeof CreateRoomPayloadSchema>;
export type JoinRoomPayload = z.infer<typeof JoinRoomPayloadSchema>;
export type LeaveRoomPayload = z.infer<typeof LeaveRoomPayloadSchema>;
export type StartGamePayload = z.infer<typeof StartGamePayloadSchema>;
export type MakeMovePayload = z.infer<typeof MakeMovePayloadSchema>;
export type ResumeSessionPayload = z.infer<typeof ResumeSessionPayloadSchema>;

export interface RoomMember {
  readonly playerId: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly isBot: boolean;
}

export interface RoomStatePayload {
  readonly roomId: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly members: readonly RoomMember[];
  readonly status: 'lobby' | 'playing' | 'finished';
}

export interface GameStatePayload {
  readonly roomId: string;
  readonly version: number;
  readonly view: PlayerView;
}

export interface GameOverPayload {
  readonly roomId: string;
  readonly durakId: string | null;
  readonly finishOrder: readonly string[];
}

export interface SessionIssuedPayload {
  readonly sessionToken: string;
  readonly playerId: string;
  readonly roomId: string;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
}

/** Typed maps for socket.io generics: `Server<ClientToServerEvents, ServerToClientEvents>`. */
export interface ClientToServerEvents {
  'room:create': (payload: CreateRoomPayload) => void;
  'room:join': (payload: JoinRoomPayload) => void;
  'room:leave': (payload: LeaveRoomPayload) => void;
  'game:start': (payload: StartGamePayload) => void;
  'game:move': (payload: MakeMovePayload) => void;
  'session:resume': (payload: ResumeSessionPayload) => void;
}

export interface ServerToClientEvents {
  'room:state': (payload: RoomStatePayload) => void;
  'game:state': (payload: GameStatePayload) => void;
  'game:over': (payload: GameOverPayload) => void;
  'session:issued': (payload: SessionIssuedPayload) => void;
  error: (payload: ErrorPayload) => void;
}
