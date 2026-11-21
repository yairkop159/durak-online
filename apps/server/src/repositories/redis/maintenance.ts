import type { Redis } from 'ioredis';
import type { Room } from '../../domain/types.js';
import { RoomSchema, decode, encode, type RepoLogger } from './codec.js';
import type { RedisKeys } from './keys.js';

/** Iterates keys matching `pattern` with SCAN (never KEYS, which blocks Redis). */
export async function* scanKeys(redis: Redis, pattern: string, count = 100): AsyncGenerator<string[]> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    if (keys.length > 0) yield keys;
  } while (cursor !== '0');
}

/**
 * Startup step: no socket survives a restart, so every stored member is offline until they
 * resume. Without this, rooms would claim "connected: true" forever for players whose sockets
 * died with the old process (their disconnect event can never fire).
 * Must run before the server starts listening. TTLs are preserved (KEEPTTL).
 */
export async function markAllMembersDisconnected(
  redis: Redis,
  keys: RedisKeys,
  log: RepoLogger,
  now: number = Date.now(),
): Promise<{ scanned: number; updated: number }> {
  let scanned = 0;
  let updated = 0;
  for await (const batch of scanKeys(redis, keys.roomPattern)) {
    for (const key of batch) {
      scanned++;
      const room = decode(RoomSchema, await redis.get(key), key, log);
      // Bots have no socket and are always connected.
      if (!room || room.members.every((m) => m.isBot || !m.connected)) continue;
      const offline: Room = {
        ...room,
        // A ghost went offline with the old process: from now on, as far as anyone can tell.
        members: room.members.map((m) =>
          m.isBot ? m : { ...m, connected: false, disconnectedAt: m.connected ? now : m.disconnectedAt },
        ),
      };
      await redis.set(key, encode(offline), 'KEEPTTL');
      updated++;
    }
  }
  return { scanned, updated };
}

/** Deletes every key under the prefix (tests / tooling). */
export async function deleteAllWithPrefix(redis: Redis, keys: RedisKeys): Promise<number> {
  let deleted = 0;
  for await (const batch of scanKeys(redis, keys.allPattern)) {
    deleted += await redis.del(...batch);
  }
  return deleted;
}
