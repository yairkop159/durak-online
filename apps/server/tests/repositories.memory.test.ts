import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '../src/repositories/inMemory/index.js';
import { describeRepositoryContract, type KeyKind } from './repositories/contract.js';
import { makeRoom } from './repositories/fixtures.js';

describeRepositoryContract('InMemory', async () => {
  const repos = createInMemoryRepositories();
  const store = (kind: KeyKind) =>
    kind === 'room' ? repos.rooms.store : kind === 'game' ? repos.games.store : repos.sessions.store;
  return {
    repos,
    ttl: async (kind, id) => store(kind).ttlSeconds(id),
    setTtl: async (kind, id, seconds) => store(kind).touch(id, seconds),
    cleanup: async () => undefined,
  };
});

describe('InMemory expiry', () => {
  it('entries disappear once their TTL has elapsed', async () => {
    let now = 1_000_000;
    const repos = createInMemoryRepositories(() => now);
    const room = makeRoom();
    await repos.rooms.save(room);
    now += 6 * 60 * 60 * 1000 - 1;
    expect(await repos.rooms.get(room.id)).not.toBeNull();
    now += 2;
    expect(await repos.rooms.get(room.id)).toBeNull();
  });
});
