import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repositories } from '../../src/repositories/interfaces.js';
import { ACTIVE_TTL_SECONDS, FINISHED_TTL_SECONDS, SESSION_TTL_SECONDS } from '../../src/repositories/ttl.js';
import { makeGame, makeRoom, makeSession } from './fixtures.js';

export type KeyKind = 'room' | 'game' | 'session';

export interface ContractHarness {
  readonly repos: Repositories;
  /** Remaining TTL in seconds, or null if the key does not exist. */
  ttl(kind: KeyKind, id: string): Promise<number | null>;
  /** Forces a short TTL, so tests can observe a later refresh. */
  setTtl(kind: KeyKind, id: string, seconds: number): Promise<void>;
  cleanup(): Promise<void>;
}

/** TTLs are checked with a small tolerance for elapsed time and rounding. */
function expectTtl(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull();
  expect(actual!).toBeGreaterThan(expected - 10);
  expect(actual!).toBeLessThanOrEqual(expected);
}

/** Behaviour every repository implementation must share (memory and Redis). */
export function describeRepositoryContract(name: string, makeHarness: () => Promise<ContractHarness>): void {
  describe(`${name} repository contract`, () => {
    let h: ContractHarness;
    beforeAll(async () => {
      h = await makeHarness();
    });
    afterAll(async () => {
      await h.cleanup();
    });

    describe('rooms', () => {
      it('round-trips, returns null when missing, and deletes', async () => {
        const room = makeRoom();
        expect(await h.repos.rooms.get(room.id)).toBeNull();
        await h.repos.rooms.save(room);
        expect(await h.repos.rooms.get(room.id)).toEqual(room);
        await h.repos.rooms.delete(room.id);
        expect(await h.repos.rooms.get(room.id)).toBeNull();
      });

      it('returns copies', async () => {
        const room = makeRoom();
        await h.repos.rooms.save(room);
        const loaded = (await h.repos.rooms.get(room.id)) as unknown as { members: unknown[] };
        loaded.members.length = 0;
        expect(await h.repos.rooms.get(room.id)).toEqual(room);
      });

      it('sets a 6h TTL while active and 30m once finished, refreshed on every save', async () => {
        const room = makeRoom();
        await h.repos.rooms.save(room);
        expectTtl(await h.ttl('room', room.id), ACTIVE_TTL_SECONDS);
        await h.setTtl('room', room.id, 10);
        await h.repos.rooms.save(room);
        expectTtl(await h.ttl('room', room.id), ACTIVE_TTL_SECONDS);
        await h.repos.rooms.save({ ...room, status: 'finished' });
        expectTtl(await h.ttl('room', room.id), FINISHED_TTL_SECONDS);
      });
    });

    describe('games', () => {
      it('round-trips, returns null when missing, and deletes', async () => {
        const game = makeGame(makeRoom().id);
        expect(await h.repos.games.get(game.roomId)).toBeNull();
        await h.repos.games.save(game);
        expect(await h.repos.games.get(game.roomId)).toEqual(game);
        await h.repos.games.delete(game.roomId);
        expect(await h.repos.games.get(game.roomId)).toBeNull();
      });

      it('returns copies', async () => {
        const game = makeGame(makeRoom().id);
        await h.repos.games.save(game);
        const loaded = (await h.repos.games.get(game.roomId)) as unknown as { state: { deck: unknown[] } };
        loaded.state.deck.length = 0;
        expect(await h.repos.games.get(game.roomId)).toEqual(game);
      });

      it('sets a 6h TTL while running and 30m once finished', async () => {
        const game = makeGame(makeRoom().id);
        await h.repos.games.save(game);
        expectTtl(await h.ttl('game', game.roomId), ACTIVE_TTL_SECONDS);
        const finished = makeGame(makeRoom().id, true);
        await h.repos.games.save(finished);
        expectTtl(await h.ttl('game', finished.roomId), FINISHED_TTL_SECONDS);
      });

      it('saving a game refreshes its room TTL', async () => {
        const room = makeRoom(undefined, 'playing');
        await h.repos.rooms.save(room);
        await h.setTtl('room', room.id, 10);
        await h.repos.games.save(makeGame(room.id));
        expectTtl(await h.ttl('room', room.id), ACTIVE_TTL_SECONDS);
      });
    });

    describe('sessions', () => {
      it('round-trips, returns null when missing, and deletes', async () => {
        const session = makeSession();
        expect(await h.repos.sessions.get(session.token)).toBeNull();
        await h.repos.sessions.create(session);
        expect(await h.repos.sessions.get(session.token)).toEqual(session);
        await h.repos.sessions.delete(session.token);
        expect(await h.repos.sessions.get(session.token)).toBeNull();
      });

      it('sets a 24h TTL that a successful read slides forward', async () => {
        const session = makeSession();
        await h.repos.sessions.create(session);
        expectTtl(await h.ttl('session', session.token), SESSION_TTL_SECONDS);
        await h.setTtl('session', session.token, 10);
        await h.repos.sessions.get(session.token);
        expectTtl(await h.ttl('session', session.token), SESSION_TTL_SECONDS);
      });

      it('returns copies', async () => {
        const session = makeSession();
        await h.repos.sessions.create(session);
        const loaded = (await h.repos.sessions.get(session.token)) as unknown as { id: string };
        loaded.id = 'hijacked';
        expect((await h.repos.sessions.get(session.token))?.id).toBe(session.id);
      });
    });

    describe('atomic room + game writes', () => {
      it('saveRoomAndGame writes both with their own TTLs; deleteRoomAndGame removes both', async () => {
        const room = makeRoom(undefined, 'finished');
        const game = makeGame(room.id, true);
        await h.repos.atomic.saveRoomAndGame(room, game);
        expect(await h.repos.rooms.get(room.id)).toEqual(room);
        expect(await h.repos.games.get(room.id)).toEqual(game);
        expectTtl(await h.ttl('room', room.id), FINISHED_TTL_SECONDS);
        expectTtl(await h.ttl('game', room.id), FINISHED_TTL_SECONDS);

        await h.repos.atomic.deleteRoomAndGame(room.id);
        expect(await h.repos.rooms.get(room.id)).toBeNull();
        expect(await h.repos.games.get(room.id)).toBeNull();
      });
    });
  });
}
