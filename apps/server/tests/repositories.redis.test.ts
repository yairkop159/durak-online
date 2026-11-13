import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  createRedisRepositories,
  deleteAllWithPrefix,
  markAllMembersDisconnected,
  redisKeys,
} from '../src/repositories/redis/index.js';
import { encode } from '../src/repositories/redis/codec.js';
import { describeRepositoryContract, type KeyKind } from './repositories/contract.js';
import { makeGame, makeRoom } from './repositories/fixtures.js';
import { newRedisClient, redisAvailable, spyLogger, testPrefix } from './helpers/redis.js';

const suite = redisAvailable ? describe : describe.skip;

suite('Redis', () => {
  describeRepositoryContract('Redis', async () => {
    const redis = newRedisClient();
    const keys = redisKeys(testPrefix());
    const keyOf = (kind: KeyKind, id: string) =>
      kind === 'room' ? keys.room(id) : kind === 'game' ? keys.game(id) : keys.session(id);
    return {
      repos: createRedisRepositories(redis, keys, spyLogger()),
      ttl: async (kind, id) => {
        const ttl = await redis.ttl(keyOf(kind, id));
        return ttl < 0 ? null : ttl;
      },
      setTtl: async (kind, id, seconds) => {
        await redis.expire(keyOf(kind, id), seconds);
      },
      cleanup: async () => {
        await deleteAllWithPrefix(redis, keys);
        redis.disconnect();
      },
    };
  });

  describe('Redis-specific behaviour', () => {
    let redis: Redis;
    const keys = redisKeys(testPrefix());
    beforeAll(() => {
      redis = newRedisClient();
    });
    afterAll(async () => {
      await deleteAllWithPrefix(redis, keys);
      redis.disconnect();
    });

    it.each([
      ['invalid JSON', '{not json'],
      ['no envelope version', JSON.stringify({ data: makeRoom() })],
      ['an older envelope version', JSON.stringify({ v: 0, data: makeRoom() })],
      ['a schema mismatch', encode({ ...makeRoom(), members: 'nobody' })],
    ])('a stored value with %s decodes as null and is logged, never thrown', async (_label, raw) => {
      const log = spyLogger();
      const repos = createRedisRepositories(redis, keys, log);
      const id = `corrupt-${Math.random().toString(36).slice(2)}`;
      await redis.set(keys.room(id), raw);
      await redis.set(keys.game(id), raw);
      await expect(repos.rooms.get(id)).resolves.toBeNull();
      await expect(repos.games.get(id)).resolves.toBeNull();
      expect(log.error).toHaveBeenCalledTimes(2);
      expect(log.error.mock.calls[0]![1]).toBe('corrupted redis value');
    });

    it('marks every human member of every room offline across many SCAN pages, keeping TTLs (bots stay connected)', async () => {
      const log = spyLogger();
      const scoped = redisKeys(testPrefix());
      const repos = createRedisRepositories(redis, scoped, log);
      const ids = Array.from({ length: 250 }, (_, i) => `ghost${i}`);
      for (const id of ids) await repos.rooms.save(makeRoom(id, 'playing'));
      await redis.expire(scoped.room('ghost0'), 1000);
      await redis.set(scoped.room('broken'), '{not json');
      // A room under a different prefix must not be touched.
      const otherKeys = redisKeys(testPrefix());
      const otherRepos = createRedisRepositories(redis, otherKeys, log);
      await otherRepos.rooms.save(makeRoom('outside', 'playing'));

      const result = await markAllMembersDisconnected(redis, scoped, log);

      expect(result).toEqual({ scanned: 251, updated: 250 });
      for (const id of ids) {
        const room = await repos.rooms.get(id);
        expect(room?.members.every((m) => (m.isBot ? m.connected : !m.connected))).toBe(true);
        expect(room?.members.some((m) => m.isBot)).toBe(true);
      }
      expect((await otherRepos.rooms.get('outside'))?.members.every((m) => m.connected)).toBe(true);
      await deleteAllWithPrefix(redis, otherKeys);
      const ttl = await redis.ttl(scoped.room('ghost0'));
      expect(ttl).toBeGreaterThan(990);
      expect(ttl).toBeLessThanOrEqual(1000);
      expect(log.error).toHaveBeenCalledTimes(1); // the broken key, skipped
      await deleteAllWithPrefix(redis, scoped);
    });

    it('room + game writes and deletes each go through exactly one MULTI', async () => {
      const repos = createRedisRepositories(redis, keys, spyLogger());
      const multi = vi.spyOn(redis, 'multi');
      const room = makeRoom(undefined, 'playing');
      await repos.atomic.saveRoomAndGame(room, makeGame(room.id));
      expect(multi).toHaveBeenCalledTimes(1);
      expect(await redis.exists(keys.room(room.id), keys.game(room.id))).toBe(2);

      await repos.atomic.deleteRoomAndGame(room.id);
      expect(multi).toHaveBeenCalledTimes(2);
      expect(await redis.exists(keys.room(room.id), keys.game(room.id))).toBe(0);
      multi.mockRestore();
    });
  });
});
