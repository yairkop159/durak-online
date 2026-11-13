/**
 * Compile-time drift guard (type-only, no runtime code).
 * If a domain type and its Zod schema in codec.ts stop matching exactly — a field added,
 * removed, renamed or retyped on one side only — `npm run typecheck` fails here.
 */
import type { GameState, PlayerState, PublicKnowledge } from '@durak/game-engine';
import type { BoutSummary, TablePair } from '@durak/shared';
import type { z } from 'zod';
import type { RestartVote, Room, RoomMember, Session, Spectator, StoredGame } from '../../domain/types.js';
import type {
  BoutSummarySchema,
  GameStateSchema,
  PlayerStateSchema,
  PublicKnowledgeSchema,
  RestartVoteSchema,
  RoomMemberSchema,
  RoomSchema,
  SessionSchema,
  SpectatorSchema,
  StoredGameSchema,
  TablePairSchema,
} from './codec.js';

/** Strips `readonly` recursively (Zod infers mutable types; domain types are readonly). */
export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/** `true` only if A and B are identical types (stricter than mutual assignability: optional keys count). */
export type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Same<S extends z.ZodTypeAny, T> = AssertEqual<DeepMutable<z.infer<S>>, DeepMutable<T>>;

export const schemaGuards: {
  room: Same<typeof RoomSchema, Room>;
  restartVote: Same<typeof RestartVoteSchema, RestartVote>;
  member: Same<typeof RoomMemberSchema, RoomMember>;
  spectator: Same<typeof SpectatorSchema, Spectator>;
  session: Same<typeof SessionSchema, Session>;
  storedGame: Same<typeof StoredGameSchema, StoredGame>;
  gameState: Same<typeof GameStateSchema, GameState>;
  playerState: Same<typeof PlayerStateSchema, PlayerState>;
  tablePair: Same<typeof TablePairSchema, TablePair>;
  boutSummary: Same<typeof BoutSummarySchema, BoutSummary>;
  knowledge: Same<typeof PublicKnowledgeSchema, PublicKnowledge>;
} = {
  knowledge: true,
  room: true,
  restartVote: true,
  member: true,
  spectator: true,
  session: true,
  storedGame: true,
  gameState: true,
  playerState: true,
  tablePair: true,
  boutSummary: true,
};
