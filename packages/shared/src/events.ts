import { z } from 'zod';
import { GameConfigInputSchema, MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { ClientMoveSchema } from './moves.js';
import type { GameErrorCode } from './errors.js';
import type { PlayerView } from './view.js';

/** Socket.io event names, client -> server. */
export const ClientEvents = {
  CreateRoom: 'room:create',
  JoinRoom: 'room:join',
  LeaveRoom: 'room:leave',
  StartGame: 'game:start',
  MakeMove: 'game:move',
  ResumeSession: 'session:resume',
  Rematch: 'room:rematch',
  AddBot: 'room:addBot',
  RemoveBot: 'room:removeBot',
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

/** After a finished game: put the room back into the lobby (same members) for another game. */
export const RematchPayloadSchema = z.object({ roomId: RoomIdSchema }).strict();

/** Bot strength: easy = greedy with random slips, medium = IS-MCTS 200 iterations, hard = IS-MCTS 300 ms. */
export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];
export const BotDifficultySchema = z.enum(BOT_DIFFICULTIES);

/** Host only, lobby only: seat a bot. */
export const AddBotPayloadSchema = z.object({ roomId: RoomIdSchema, difficulty: BotDifficultySchema }).strict();

/** Host only, lobby only: remove a bot seat. */
export const RemoveBotPayloadSchema = z
  .object({ roomId: RoomIdSchema, playerId: z.string().min(1).max(64) })
  .strict();

export const MakeMovePayloadSchema = z
  .object({
    roomId: RoomIdSchema,
    move: ClientMoveSchema,
    /**
     * Required. Must equal the `version` of the last `game:state` the client received;
     * the server rejects moves made against a stale state.
     */
    expectedVersion: z.number().int().min(0),
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
  [ClientEvents.Rematch]: RematchPayloadSchema,
  [ClientEvents.AddBot]: AddBotPayloadSchema,
  [ClientEvents.RemoveBot]: RemoveBotPayloadSchema,
} as const satisfies Record<ClientEventName, z.ZodTypeAny>;

export type CreateRoomPayload = z.infer<typeof CreateRoomPayloadSchema>;
export type JoinRoomPayload = z.infer<typeof JoinRoomPayloadSchema>;
export type LeaveRoomPayload = z.infer<typeof LeaveRoomPayloadSchema>;
export type StartGamePayload = z.infer<typeof StartGamePayloadSchema>;
export type MakeMovePayload = z.infer<typeof MakeMovePayloadSchema>;
export type ResumeSessionPayload = z.infer<typeof ResumeSessionPayloadSchema>;
export type RematchPayload = z.infer<typeof RematchPayloadSchema>;
export type AddBotPayload = z.infer<typeof AddBotPayloadSchema>;
export type RemoveBotPayload = z.infer<typeof RemoveBotPayloadSchema>;

export interface RoomMember {
  readonly playerId: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly isBot: boolean;
  /** Set for bot seats only. */
  readonly botDifficulty: BotDifficulty | null;
  /** Two consecutive turn timeouts; cleared by a human move or session:resume. */
  readonly afk: boolean;
}

export interface RoomStatePayload {
  readonly roomId: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly members: readonly RoomMember[];
  readonly spectatorCount: number;
  readonly status: 'lobby' | 'playing' | 'finished';
}

export interface GameStatePayload {
  readonly roomId: string;
  readonly version: number;
  readonly view: PlayerView;
  /** When the current turn times out (epoch ms), or null when no timer runs (game over). */
  readonly turnDeadline: number | null;
  /** Server clock when this payload was sent; remaining time = turnDeadline - serverTime. */
  readonly serverTime: number;
}

/**
 * How a game ended:
 * - normal: played out (durak may be null for a simultaneous last-card draw);
 * - forfeit: a player's reconnection grace expired (that player is the durak);
 * - abandoned: everyone idle — stopped by the server's abandon guard, no durak.
 *   Abandoned games are not rated.
 */
export const GAME_END_REASONS = ['normal', 'forfeit', 'abandoned'] as const;
export type GameEndReason = (typeof GAME_END_REASONS)[number];

export interface GameOverPayload {
  readonly roomId: string;
  readonly durakId: string | null;
  readonly finishOrder: readonly string[];
  readonly endReason: GameEndReason;
  /** Human seats a bot ever played for (AFK takeover). For ratings (Phase 3d). */
  readonly botAssisted: readonly string[];
}

export interface SessionIssuedPayload {
  readonly sessionToken: string;
  readonly playerId: string;
  readonly roomId: string;
}

/** Error codes produced by the server itself (engine rule violations use GameErrorCode). */
export const SERVER_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'NOT_IN_ROOM',
  'ROOM_NOT_FOUND',
  'NOT_HOST',
  'NOT_ENOUGH_PLAYERS',
  'GAME_NOT_STARTED',
  'GAME_IN_PROGRESS',
  'STALE_STATE',
  'INVALID_SESSION',
  'ROOM_FULL',
  'NOT_A_BOT',
  'NO_HUMANS',
  'INTERNAL',
  /** Too many events from this connection; the event was dropped. */
  'RATE_LIMITED',
  /** This address created too many rooms recently (per hour). */
  'TOO_MANY_ROOMS',
  /** The server holds its maximum number of rooms. */
  'SERVER_FULL',
  /** Connection refused: too many open connections from this address (a connect_error message). */
  'TOO_MANY_CONNECTIONS',
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export interface ErrorPayload {
  readonly code: ServerErrorCode | GameErrorCode;
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
  'room:rematch': (payload: RematchPayload) => void;
  'room:addBot': (payload: AddBotPayload) => void;
  'room:removeBot': (payload: RemoveBotPayload) => void;
}

export interface ServerToClientEvents {
  'room:state': (payload: RoomStatePayload) => void;
  'game:state': (payload: GameStatePayload) => void;
  'game:over': (payload: GameOverPayload) => void;
  'session:issued': (payload: SessionIssuedPayload) => void;
  error: (payload: ErrorPayload) => void;
}
