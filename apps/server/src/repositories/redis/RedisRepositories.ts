import type { Redis } from 'ioredis';
import type { Room, Session, StoredGame } from '../../domain/types.js';
import type {
  GameRepository,
  Repositories,
  RoomGameTransaction,
  RoomRepository,
  SessionRepository,
} from '../interfaces.js';
import { SESSION_TTL_SECONDS, gameTtlSeconds, roomTtlSeconds } from '../ttl.js';
import { RoomSchema, SessionSchema, StoredGameSchema, decode, encode, type RepoLogger } from './codec.js';
import type { RedisKeys } from './keys.js';

interface Ctx {
  readonly redis: Redis;
  readonly keys: RedisKeys;
  readonly log: RepoLogger;
}

/** Throws if any command inside a MULTI failed (EXEC itself only reports per-command errors). */
async function execOrThrow(multi: ReturnType<Redis['multi']>): Promise<void> {
  const results = await multi.exec();
  if (results === null) throw new Error('Redis transaction aborted');
  for (const [error] of results) if (error) throw error;
}

export class RedisRoomRepository implements RoomRepository {
  constructor(private readonly ctx: Ctx) {}

  async get(roomId: string): Promise<Room | null> {
    const key = this.ctx.keys.room(roomId);
    return decode(RoomSchema, await this.ctx.redis.get(key), key, this.ctx.log);
  }

  async save(room: Room): Promise<void> {
    await this.ctx.redis.set(this.ctx.keys.room(room.id), encode(room), 'EX', roomTtlSeconds(room));
  }

  async delete(roomId: string): Promise<void> {
    await this.ctx.redis.del(this.ctx.keys.room(roomId));
  }
}

export class RedisGameRepository implements GameRepository {
  constructor(private readonly ctx: Ctx) {}

  async get(roomId: string): Promise<StoredGame | null> {
    const key = this.ctx.keys.game(roomId);
    return decode(StoredGameSchema, await this.ctx.redis.get(key), key, this.ctx.log);
  }

  /**
   * Also refreshes the room key's TTL in the same transaction, so a long game cannot
   * outlive its room. (Room and game share a status: both finished, or neither.)
   */
  async save(game: StoredGame): Promise<void> {
    const ttl = gameTtlSeconds(game);
    await execOrThrow(
      this.ctx.redis
        .multi()
        .set(this.ctx.keys.game(game.roomId), encode(game), 'EX', ttl)
        .expire(this.ctx.keys.room(game.roomId), ttl),
    );
  }

  async delete(roomId: string): Promise<void> {
    await this.ctx.redis.del(this.ctx.keys.game(roomId));
  }
}

export class RedisSessionRepository implements SessionRepository {
  constructor(private readonly ctx: Ctx) {}

  async create(session: Session): Promise<void> {
    await this.ctx.redis.set(this.ctx.keys.session(session.token), encode(session), 'EX', SESSION_TTL_SECONDS);
  }

  /** GETEX: a successful read (session:resume) slides the 24h expiry. */
  async get(token: string): Promise<Session | null> {
    const key = this.ctx.keys.session(token);
    return decode(SessionSchema, await this.ctx.redis.getex(key, 'EX', SESSION_TTL_SECONDS), key, this.ctx.log);
  }

  async delete(token: string): Promise<void> {
    await this.ctx.redis.del(this.ctx.keys.session(token));
  }
}

export class RedisRoomGameTransaction implements RoomGameTransaction {
  constructor(private readonly ctx: Ctx) {}

  async saveRoomAndGame(room: Room, game: StoredGame): Promise<void> {
    await execOrThrow(
      this.ctx.redis
        .multi()
        .set(this.ctx.keys.room(room.id), encode(room), 'EX', roomTtlSeconds(room))
        .set(this.ctx.keys.game(game.roomId), encode(game), 'EX', gameTtlSeconds(game)),
    );
  }

  async deleteRoomAndGame(roomId: string): Promise<void> {
    await execOrThrow(this.ctx.redis.multi().del(this.ctx.keys.room(roomId)).del(this.ctx.keys.game(roomId)));
  }
}

export function createRedisRepositories(redis: Redis, keys: RedisKeys, log: RepoLogger): Repositories {
  const ctx: Ctx = { redis, keys, log };
  return {
    rooms: new RedisRoomRepository(ctx),
    games: new RedisGameRepository(ctx),
    sessions: new RedisSessionRepository(ctx),
    atomic: new RedisRoomGameTransaction(ctx),
  };
}
