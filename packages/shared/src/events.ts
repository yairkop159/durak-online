import { z } from 'zod';
import { GameConfigInputSchema, MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { ClientMoveSchema } from './moves.js';
import type { GameErrorCode } from './errors.js';
import { ReactionIdSchema, type ReactionId } from './reactions.js';
import type { GameRatingsPayload } from './ratings.js';
import type { GameStats } from './stats.js';
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
  RestartPropose: 'room:restartPropose',
  RestartRespond: 'room:restartRespond',
  React: 'room:react',
} as const;
export type ClientEventName = (typeof ClientEvents)[keyof typeof ClientEvents];

/** Socket.io event names, server -> client. */
export const ServerEvents = {
  RoomState: 'room:state',
  GameState: 'game:state',
  GameOver: 'game:over',
  /** The rating outcome of a finished game (pending / rated / unrated); see ratings.ts. */
  GameRatings: 'game:ratings',
  Session: 'session:issued',
  RestartVoteEnded: 'room:restartVoteEnded',
  Reaction: 'room:reaction',
  Error: 'error',
} as const;
export type ServerEventName = (typeof ServerEvents)[keyof typeof ServerEvents];

export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,32}$/, 'Invalid room id');
export const NicknameSchema = z.string().trim().min(1).max(24);
export const SessionTokenSchema = z.string().min(16).max(256);
/**
 * A profile's secret device key (Phase 10, 32 random bytes base64url). Optional on create/join:
 * the seat is linked to that profile for ratings; unknown or unresolvable keys seat unprofiled.
 */
const SeatDeviceKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid device key');

export const CreateRoomPayloadSchema = z
  .object({
    nickname: NicknameSchema,
    maxPlayers: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    config: GameConfigInputSchema.optional(),
    deviceKey: SeatDeviceKeySchema.optional(),
  })
  .strict();

export const JoinRoomPayloadSchema = z
  .object({
    roomId: RoomIdSchema,
    nickname: NicknameSchema,
    deviceKey: SeatDeviceKeySchema.optional(),
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

/** A seated human proposes to end the running game and deal a new one (same seats and config). */
export const RestartProposePayloadSchema = z.object({ roomId: RoomIdSchema }).strict();

export const VoteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Invalid vote id');

/** An awaited voter answers the open restart vote. */
export const RestartRespondPayloadSchema = z
  .object({ roomId: RoomIdSchema, voteId: VoteIdSchema, accept: z.boolean() })
  .strict();

/** A seated player sends a quick reaction (ephemeral: broadcast to the room, never stored). */
export const ReactPayloadSchema = z.object({ roomId: RoomIdSchema, reactionId: ReactionIdSchema }).strict();

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
  [ClientEvents.RestartPropose]: RestartProposePayloadSchema,
  [ClientEvents.RestartRespond]: RestartRespondPayloadSchema,
  [ClientEvents.React]: ReactPayloadSchema,
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
export type RestartProposePayload = z.infer<typeof RestartProposePayloadSchema>;
export type RestartRespondPayload = z.infer<typeof RestartRespondPayloadSchema>;
export type ReactPayload = z.infer<typeof ReactPayloadSchema>;

export interface RoomMember {
  readonly playerId: string;
  readonly nickname: string;
  readonly connected: boolean;
  readonly isBot: boolean;
  /** Set for bot seats only. */
  readonly botDifficulty: BotDifficulty | null;
  /** Two consecutive turn timeouts; cleared by a human move or session:resume. */
  readonly afk: boolean;
  /** The human who held this seat left the running game; if `isBot`, a bot now plays it. */
  readonly leftGame: boolean;
}

/** The open restart vote, as every room member sees it. */
export interface RestartVoteState {
  readonly voteId: string;
  readonly proposerId: string;
  /** Epoch ms when the vote expires; remaining = expiresAt - serverTime (clock-skew free). */
  readonly expiresAt: number;
  readonly serverTime: number;
  readonly accepted: readonly string[];
  /** Voters who have not answered yet (connected, non-AFK humans other than the proposer). */
  readonly awaiting: readonly string[];
}

export interface RoomStatePayload {
  readonly roomId: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly members: readonly RoomMember[];
  readonly spectatorCount: number;
  readonly status: 'lobby' | 'playing' | 'finished';
  /** The open restart vote, or null. */
  readonly restartVote: RestartVoteState | null;
}

export const RESTART_VOTE_OUTCOMES = ['passed', 'declined', 'expired', 'cancelled'] as const;
export type RestartVoteOutcome = (typeof RESTART_VOTE_OUTCOMES)[number];

export interface RestartVoteEndedPayload {
  readonly roomId: string;
  readonly voteId: string;
  readonly proposerId: string;
  readonly outcome: RestartVoteOutcome;
  /** Who declined (outcome 'declined'), else null. */
  readonly by: string | null;
}

/** Someone in the room reacted (players and bots; sent to everyone, spectators included). */
export interface ReactionPayload {
  readonly roomId: string;
  readonly playerId: string;
  readonly reactionId: ReactionId;
}

export interface GameStatePayload {
  readonly roomId: string;
  /** Changes with every new game in the room (a restart deals a new game at version 0). */
  readonly gameId: string;
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
 * - forfeit: a player left, or their reconnection grace expired, and nobody could continue for
 *   them (that player is the durak);
 * - abandoned: everyone idle — stopped by the server's abandon guard, no durak.
 *   Abandoned games are not rated.
 * - restarted: the players voted for a new game; no durak, not rated.
 */
export const GAME_END_REASONS = ['normal', 'forfeit', 'abandoned', 'restarted'] as const;
export type GameEndReason = (typeof GAME_END_REASONS)[number];

export interface GameOverPayload {
  readonly roomId: string;
  readonly durakId: string | null;
  readonly finishOrder: readonly string[];
  readonly endReason: GameEndReason;
  /** Human seats a bot ever played for (AFK or leave takeover). Marked in the match history. */
  readonly botAssisted: readonly string[];
  /**
   * Humans who left the game (or whose reconnection grace expired). Rating semantics (Phase 10):
   * every id here is a loss, `durakId` is a loss, and games ending 'abandoned' or 'restarted' are
   * not rated.
   */
  readonly forfeits: readonly string[];
  /** Per-player end-of-game statistics (public information only). */
  readonly stats: GameStats;
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
  /** A restart vote is already open in this room. */
  'VOTE_IN_PROGRESS',
  /** This player proposed a restart too recently. */
  'VOTE_COOLDOWN',
  /** No open restart vote that this player may answer (ended, or another vote id). */
  'NO_ACTIVE_VOTE',
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
  'room:restartPropose': (payload: RestartProposePayload) => void;
  'room:restartRespond': (payload: RestartRespondPayload) => void;
  'room:react': (payload: ReactPayload) => void;
}

export interface ServerToClientEvents {
  'room:state': (payload: RoomStatePayload) => void;
  'game:state': (payload: GameStatePayload) => void;
  'game:over': (payload: GameOverPayload) => void;
  'game:ratings': (payload: GameRatingsPayload) => void;
  'session:issued': (payload: SessionIssuedPayload) => void;
  'room:restartVoteEnded': (payload: RestartVoteEndedPayload) => void;
  'room:reaction': (payload: ReactionPayload) => void;
  error: (payload: ErrorPayload) => void;
}
