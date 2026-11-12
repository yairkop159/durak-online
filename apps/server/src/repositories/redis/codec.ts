import { CardSchema, GameConfigInputSchema, GameConfigSchema } from '@durak/shared';
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
    isBot: z.literal(false),
  })
  .strict();

export const SpectatorSchema = z.object({ spectatorId: z.string(), nickname: z.string() }).strict();

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
  })
  .strict();

export const StoredGameSchema = z
  .object({
    roomId: z.string(),
    seed: z.number().int(),
    version: z.number().int(),
    state: GameStateSchema,
    startedAt: z.number(),
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
