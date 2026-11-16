import {
  BotDifficultySchema,
  CardSchema,
  GAME_END_REASONS,
  GameConfigInputSchema,
  GameConfigSchema,
  RatingEntrySchema,
} from '@durak/shared';
import { z } from 'zod';

/**
 * Zod schemas for every persisted record. They duplicate the TS domain types on purpose
 * (validation on read); `schemaGuards.ts` makes typecheck fail if the two drift apart.
 */

export const RoomMemberSchema = z
  .object({
    playerId: z.string(),
    nickname: z.string(),
    connected: z.boolean(),
    isBot: z.boolean(),
    // Defaults let records written before Phase 3c / 4b decode without a format bump.
    botDifficulty: BotDifficultySchema.nullable().default(null),
    afk: z.boolean().default(false),
    consecutiveTimeouts: z.number().int().min(0).default(0),
    graceDeadline: z.number().nullable().default(null),
    leftGame: z.boolean().default(false), // Phase 7
    profileId: z.string().nullable().default(null), // Phase 10
  })
  .strict();

export const SpectatorSchema = z.object({ spectatorId: z.string(), nickname: z.string() }).strict();

export const RestartVoteSchema = z
  .object({
    voteId: z.string(),
    proposerId: z.string(),
    expiresAt: z.number(),
    voters: z.array(z.string()),
    accepted: z.array(z.string()),
  })
  .strict();

export const RoomSchema = z
  .object({
    id: z.string(),
    hostId: z.string(),
    maxPlayers: z.number().int(),
    config: GameConfigInputSchema,
    members: z.array(RoomMemberSchema),
    spectators: z.array(SpectatorSchema),
    status: z.enum(['lobby', 'playing', 'finished']),
    createdAt: z.number(),
    // Phase 7
    restartVote: RestartVoteSchema.nullable().default(null),
    restartCooldowns: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export const SessionSchema = z
  .object({
    token: z.string(),
    roomId: z.string(),
    role: z.enum(['player', 'spectator']),
    id: z.string(),
  })
  .strict();

export const PlayerStateSchema = z.object({ id: z.string(), hand: z.array(CardSchema) }).strict();

export const TablePairSchema = z.object({ attack: CardSchema, defense: CardSchema.nullable() }).strict();

export const BoutSummarySchema = z
  .object({
    table: z.array(TablePairSchema),
    outcome: z.enum(['beaten', 'taken']),
    defenderId: z.string(),
  })
  .strict();

export const GamePhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('awaitingAttack') }).strict(),
  z.object({ kind: z.literal('bout'), taking: z.boolean(), passed: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('finished'), durak: z.string().nullable() }).strict(),
]);

export const GameStateSchema = z
  .object({
    config: GameConfigSchema,
    players: z.array(PlayerStateSchema),
    deck: z.array(CardSchema),
    trumpCard: CardSchema,
    discard: z.array(CardSchema),
    table: z.array(TablePairSchema),
    attackerIndex: z.number().int(),
    defenderIndex: z.number().int(),
    phase: GamePhaseSchema,
    boutNumber: z.number().int(),
    finishOrder: z.array(z.string()),
    // Default lets games written before Phase 5b decode without a format bump.
    lastBout: BoutSummarySchema.nullable().default(null),
  })
  .strict();

export const PublicKnowledgeSchema = z
  .object({
    viewerId: z.string().nullable(),
    discard: z.array(z.string()),
    knownHands: z.record(z.string(), z.array(z.string())),
  })
  .strict();

export const PlayerStatsSchema = z
  .object({
    boutsAttacked: z.number().int().min(0),
    boutsDefended: z.number().int().min(0),
    defenses: z.number().int().min(0),
    takes: z.number().int().min(0),
    cardsTaken: z.number().int().min(0),
    throwIns: z.number().int().min(0),
    transfers: z.number().int().min(0),
    cardsPlayed: z.number().int().min(0),
  })
  .strict();

export const StoredGameSchema = z
  .object({
    roomId: z.string(),
    gameId: z.string().default(''), // Phase 7
    seed: z.number().int(),
    version: z.number().int(),
    state: GameStateSchema,
    startedAt: z.number(),
    turnDeadline: z.number().nullable().default(null),
    timeoutStreak: z.number().int().min(0).default(0),
    endReason: z.enum(GAME_END_REASONS).nullable().default(null),
    // Phase 4b. Missing knowledge is rebuilt with initKnowledge (sound: it only forgets history).
    knowledge: z.record(z.string(), PublicKnowledgeSchema).default({}),
    botAssisted: z.array(z.string()).default([]),
    forfeits: z.array(z.string()).default([]), // Phase 7
    stats: z.record(z.string(), PlayerStatsSchema).default({}), // Phase 8
    profiles: z.record(z.string(), z.string()).default({}), // Phase 10
    ratings: z.array(RatingEntrySchema).nullable().default(null), // rating delta on game over
  })
  .strict();

/** Bump when the stored shape changes incompatibly; older values then decode as null. */
export const ENVELOPE_VERSION = 1;

export interface RepoLogger {
  error(obj: object, msg: string): void;
}

export function encode(data: unknown): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, data });
}

/** Decodes a stored value. Anything unexpected is logged and becomes null — never a throw. */
export function decode<S extends z.ZodTypeAny>(
  schema: S,
  raw: string | null,
  key: string,
  log: RepoLogger,
): z.infer<S> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error({ key, reason: 'invalid JSON' }, 'corrupted redis value');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== ENVELOPE_VERSION) {
    log.error({ key, reason: 'missing or unsupported envelope version' }, 'corrupted redis value');
    return null;
  }
  const result = schema.safeParse((parsed as { data?: unknown }).data);
  if (!result.success) {
    log.error({ key, reason: result.error.issues.slice(0, 3) }, 'corrupted redis value');
    return null;
  }
  return result.data as z.infer<S>;
}
