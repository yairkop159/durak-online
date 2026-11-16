import type { BotDifficulty, GameRatingsPayload } from '@durak/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/domain/types.js';
import { buildResultInput } from '../src/ratings/resultInput.js';
import { ratingStatusFor } from '../src/ratings/ratingStatus.js';
import type { Repositories } from '../src/repositories/interfaces.js';
import { createInMemoryRepositories } from '../src/repositories/inMemory/index.js';
import { createRedisRepositories, deleteAllWithPrefix, redisKeys } from '../src/repositories/redis/index.js';
import { FINISHED_TTL_SECONDS } from '../src/repositories/ttl.js';
import { FakeTime } from './helpers/fakeTime.js';
import { MemoryResultStore } from './helpers/memoryResultStore.js';
import { newRedisClient, redisAvailable, spyLogger, testPrefix } from './helpers/redis.js';
import { noBind, setupServices, unwrap, type ServiceHarnessOptions } from './helpers/serviceHarness.js';

type Ctx = ReturnType<typeof setupServices>;
const longTurns = { turnTimeoutMs: 10 * 60_000 };
const prof = (i: number) => `profile${i}`.padEnd(22, 'x');

/** `humans` humans (profiled unless listed in `unprofiled`) + bots, started. */
async function startRoom(ctx: Ctx, humans: number, unprofiled: number[] = [], bots: BotDifficulty[] = []) {
  const profileOf = (i: number) => (unprofiled.includes(i) ? null : prof(i));
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: humans + bots.length, profileId: profileOf(0) }, noBind));
  const sessions: Session[] = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind, profileOf(i))));
  for (const d of bots) await unwrap(ctx.rooms.addBot(host, d));
  await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, sessions };
}

/** Ends a 2-player game at once: the guest leaves → forfeit (rated when both are profiled). */
async function forfeitGame(ctx: Ctx, unprofiled: number[] = []) {
  const { roomId, sessions } = await startRoom(ctx, 2, unprofiled);
  await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
  return { roomId, host: sessions[0]!, leaver: sessions[1]! };
}

const ratingsEvents = (ctx: Ctx): GameRatingsPayload[] => ctx.notifier.of('ratings').map((e) => e.ratings!);
const settle = (ctx: Ctx) => ctx.time.advanceBy(0);
const setup = (store: MemoryResultStore, more: ServiceHarnessOptions = {}) => setupServices({ settings: longTurns, results: store, ...more });

describe('game:ratings (service level, fake store that rates like Postgres)', () => {
  it('a rated game: pending right after game:over, then exactly one rated after the commit, kept on the finished game', async () => {
    const store = new MemoryResultStore();
    const ctx = setup(store);
    let release!: () => void;
    store.hold = new Promise((r) => (release = r)); // keep the write "in the transaction"
    const { roomId, host, leaver } = await forfeitGame(ctx);
    const finished = (await ctx.repos.games.get(roomId))!;

    // Only the pending status so far, and it comes after game:over.
    expect(ratingsEvents(ctx)).toEqual([{ roomId, gameId: finished.gameId, status: 'pending' }]);
    const kinds = ctx.notifier.events.map((e) => e.kind);
    expect(kinds.indexOf('ratings')).toBeGreaterThan(kinds.indexOf('over'));

    await settle(ctx);
    expect(ratingsEvents(ctx)).toHaveLength(1); // still in the transaction: nothing announced
    release();
    await settle(ctx);

    const rated = ratingsEvents(ctx).filter((e) => e.status === 'rated');
    expect(rated).toEqual([
      {
        roomId,
        gameId: finished.gameId,
        status: 'rated',
        entries: expect.arrayContaining([
          { playerId: host.id, before: 1000, after: 1016, delta: 16 },
          { playerId: leaver.id, before: 1000, after: 984, delta: -16 },
        ]),
      },
    ]);
    const stored = (await ctx.repos.games.get(roomId))!;
    expect(stored.ratings).toEqual((rated[0] as { entries: unknown }).entries);
    expect(stored.version).toBe(finished.version); // not a new version
  });

  it('a duplicate write (startup re-submission, a retry) announces nothing', async () => {
    const store = new MemoryResultStore();
    const ctx = setup(store);
    const { roomId } = await forfeitGame(ctx);
    await settle(ctx);
    expect(ratingsEvents(ctx).map((e) => e.status)).toEqual(['pending', 'rated']);

    // The game is still in the store; a re-submission is a duplicate.
    expect(await ctx.recorder!.resubmitFinished(ctx.repos)).toBe(1);
    await settle(ctx);
    expect(store.calls).toBe(2);
    expect(ratingsEvents(ctx).map((e) => e.status)).toEqual(['pending', 'rated']);
    expect((await ctx.repos.games.get(roomId))!.ratings).toHaveLength(2);
  });

  it('a game that is not rated: unrated with the reason, never rated', async () => {
    const store = new MemoryResultStore();
    const ctx = setup(store);
    const { roomId } = await forfeitGame(ctx, [1]); // the guest has no profile
    await settle(ctx);
    const gameId = (await ctx.repos.games.get(roomId))!.gameId;
    expect(ratingsEvents(ctx)).toEqual([{ roomId, gameId, status: 'unrated', reason: 'notEnoughProfiles' }]);
    expect(store.stored.has(gameId)).toBe(true); // stored for the history all the same

    // Abandoned (everyone idle) → not finished.
    const idle = setupServices({ results: new MemoryResultStore() });
    const { roomId: idleRoom } = await startRoom(idle, 2);
    for (let i = 0; i < 200 && (await idle.repos.games.get(idleRoom))!.state.phase.kind !== 'finished'; i++) await idle.time.advanceBy(30_000);
    await settle(idle);
    expect(ratingsEvents(idle).map((e) => (e.status === 'unrated' ? e.reason : e.status))).toEqual(['notFinished']);
  });

  it('Postgres down when the game ends: no game:ratings at all; the write stays queued', async () => {
    const store = new MemoryResultStore();
    store.down = true;
    const ctx = setup(store, { ratingsReady: () => false });
    await forfeitGame(ctx);
    await ctx.time.advanceBy(10 * 60_000); // several retries
    expect(store.calls).toBeGreaterThan(1);
    expect(ratingsEvents(ctx)).toEqual([]);
    expect(ctx.resultQueue!.size).toBe(1);
  });

  it('Postgres fails after the game ended (looked connected): pending only, never rated', async () => {
    const store = new MemoryResultStore();
    store.down = true;
    const ctx = setup(store);
    await forfeitGame(ctx);
    await ctx.time.advanceBy(10 * 60_000);
    expect(ratingsEvents(ctx).map((e) => e.status)).toEqual(['pending']);
  });

  it('a rematch before the commit: the rating is still written, but nothing is announced or saved on the new lobby', async () => {
    const store = new MemoryResultStore();
    const ctx = setup(store);
    let release!: () => void;
    store.hold = new Promise((r) => (release = r));
    const { roomId, host } = await forfeitGame(ctx);
    await unwrap(ctx.rooms.rematch(host));
    expect(await ctx.repos.games.get(roomId)).toBeNull();
    release();
    await settle(ctx);
    expect(store.ratings.size).toBe(2); // rated in "Postgres"
    expect(ratingsEvents(ctx).map((e) => e.status)).toEqual(['pending']);
    expect(await ctx.repos.games.get(roomId)).toBeNull();
  });

  it('resume of a finished game re-sends the status to that player (pending, then rated after the commit)', async () => {
    const store = new MemoryResultStore();
    const ctx = setup(store);
    let release!: () => void;
    store.hold = new Promise((r) => (release = r));
    const { roomId, host } = await forfeitGame(ctx);
    const gameId = (await ctx.repos.games.get(roomId))!.gameId;

    await unwrap(ctx.rooms.resume(host.token, noBind));
    expect(ctx.notifier.of('ratingsTo').map((e) => [e.to, e.ratings])).toEqual([[host.id, { roomId, gameId, status: 'pending' }]]);
    const tos = ctx.notifier.events.map((e) => e.kind);
    expect(tos.lastIndexOf('ratingsTo')).toBeGreaterThan(tos.lastIndexOf('gameTo')); // after the finished view

    release();
    await settle(ctx);
    await unwrap(ctx.rooms.resume(host.token, noBind));
    const last = ctx.notifier.of('ratingsTo').at(-1)!.ratings!;
    expect(last.status).toBe('rated');
    expect(last.status === 'rated' && last.entries.find((e) => e.playerId === host.id)?.delta).toBe(16);
  });

  it('ratings off (no store configured): nothing is ever sent', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await startRoom(ctx, 2);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await unwrap(ctx.rooms.resume(sessions[0]!.token, noBind));
    expect((await ctx.repos.games.get(roomId))!.state.phase.kind).toBe('finished');
    expect(ctx.notifier.of('ratings')).toEqual([]);
    expect(ctx.notifier.of('ratingsTo')).toEqual([]);
  });
});

describe('ratingStatusFor (pure)', () => {
  it('rated wins over availability; unavailable → null; otherwise pending / unrated', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await startRoom(ctx, 2);
    const room = (await ctx.repos.rooms.get(roomId))!;
    const running = (await ctx.repos.games.get(roomId))!;
    expect(ratingStatusFor(room, running, true)).toBeNull(); // not finished
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    const game = (await ctx.repos.games.get(roomId))!;
    const base = { roomId, gameId: game.gameId };
    expect(ratingStatusFor(room, game, true)).toEqual({ ...base, status: 'pending' });
    expect(ratingStatusFor(room, game, false)).toBeNull();
    expect(ratingStatusFor(room, { ...game, endReason: 'restarted' }, true)).toEqual({ ...base, status: 'unrated', reason: 'notFinished' });
    expect(ratingStatusFor(room, { ...game, profiles: {} }, true)).toEqual({ ...base, status: 'unrated', reason: 'notEnoughProfiles' });
    const entries = [
      { playerId: 'a', before: 1000, after: 1016, delta: 16 },
      { playerId: 'b', before: 1000, after: 984, delta: -16 },
    ];
    expect(ratingStatusFor(room, { ...game, ratings: entries }, false)).toEqual({ ...base, status: 'rated', entries });
  });
});

/**
 * The publisher re-saves the finished game: it must keep the game's remaining finished TTL (and
 * its room's), keep the version, and must not go through the committer (no listener fires).
 */
function describePublisherWrite(name: string, makeRepos: (time: FakeTime) => Promise<{ repos: Repositories; ttl: (key: 'room' | 'game', id: string) => Promise<number | null>; setTtl: (key: 'room' | 'game', id: string, s: number) => Promise<void> }>) {
  it(`${name}: keeps the remaining TTL of the game and the room, the version, and fires no GameChangeListener`, async () => {
    const time = new FakeTime();
    const { repos, ttl, setTtl } = await makeRepos(time);
    const store = new MemoryResultStore();
    store.hold = new Promise(() => undefined); // the queue never commits here; the test publishes itself
    const ctx = setupServices({ repos, time, settings: longTurns, results: store, bots: { afkTakeover: true } });
    const { roomId } = await forfeitGame(ctx);
    const room = (await repos.rooms.get(roomId))!;
    const game = (await repos.games.get(roomId))!;
    expect(game.state.phase.kind).toBe('finished');

    // 10 minutes of the finished TTL are gone (game), a bit more for the room.
    await setTtl('game', roomId, FINISHED_TTL_SECONDS - 600);
    await setTtl('room', roomId, FINISHED_TTL_SECONDS - 700);
    const listeners = [vi.spyOn(ctx.bots, 'onGameChanged'), vi.spyOn(ctx.reactions, 'onGameChanged'), vi.spyOn(ctx.recorder!, 'onGameChanged')];

    const entries = [
      { playerId: game.state.players[0]!.id, before: 1000, after: 1016, delta: 16 },
      { playerId: game.state.players[1]!.id, before: 1000, after: 984, delta: -16 },
    ];
    expect(await ctx.publisher.publish(buildResultInput(room, game, time.now())!, entries)).toBe(true);

    const gameTtl = (await ttl('game', roomId))!;
    expect(gameTtl).toBeLessThanOrEqual(FINISHED_TTL_SECONDS - 600);
    expect(gameTtl).toBeGreaterThan(FINISHED_TTL_SECONDS - 620);
    expect(gameTtl).toBeLessThanOrEqual(FINISHED_TTL_SECONDS);
    expect((await ttl('room', roomId))!).toBeLessThanOrEqual(FINISHED_TTL_SECONDS - 700);
    const after = (await repos.games.get(roomId))!;
    expect(after.version).toBe(game.version);
    expect(after.ratings).toEqual(entries);
    expect({ ...after, ratings: null }).toEqual(game); // nothing else changed
    for (const spy of listeners) expect(spy).not.toHaveBeenCalled();

    // A second announcement for the same game is ignored.
    expect(await ctx.publisher.publish(buildResultInput(room, game, time.now())!, entries)).toBe(false);
    expect(ctx.notifier.of('ratings').filter((e) => e.ratings!.status === 'rated')).toHaveLength(1);
  });
}

describe('RatingsPublisher write', () => {
  describePublisherWrite('in-memory', async (time) => {
    const repos = createInMemoryRepositories(() => time.now());
    const storeOf = (k: 'room' | 'game') => (k === 'room' ? repos.rooms.store : repos.games.store);
    return {
      repos,
      ttl: async (k, id) => storeOf(k).ttlSeconds(id),
      setTtl: async (k, id, s) => storeOf(k).touch(id, s),
    };
  });

  (redisAvailable ? describe : describe.skip)('Redis', () => {
    let redis: Redis;
    const keys = redisKeys(testPrefix());
    beforeAll(() => {
      redis = newRedisClient();
    });
    afterAll(async () => {
      await deleteAllWithPrefix(redis, keys);
      redis.disconnect();
    });
    describePublisherWrite('Redis', async () => {
      const keyOf = (k: 'room' | 'game', id: string) => (k === 'room' ? keys.room(id) : keys.game(id));
      return {
        repos: createRedisRepositories(redis, keys, spyLogger()),
        ttl: async (k, id) => {
          const t = await redis.ttl(keyOf(k, id));
          return t < 0 ? null : t;
        },
        setTtl: async (k, id, s) => {
          await redis.expire(keyOf(k, id), s);
        },
      };
    });
  });
});
