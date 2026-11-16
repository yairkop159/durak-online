import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryProfileStore } from '../src/ratings/MemoryProfileStore.js';
import { PrismaProfileStore } from '../src/ratings/PrismaProfileStore.js';
import { freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';
import { profileStoreContract } from './helpers/profileStoreContract.js';

profileStoreContract('memory', async () => ({ store: new MemoryProfileStore(), cleanup: async () => {} }));

const pg = postgresAvailable ? describe : describe.skip;

if (postgresAvailable) {
  profileStoreContract('postgres', async () => {
    const db = await freshDatabase();
    return { store: new PrismaProfileStore(() => db.prisma), cleanup: () => db.drop() };
  });
}

pg('PrismaProfileStore storage', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  }, 60_000);
  afterAll(async () => db?.drop());

  it('stores only hashes of the device key and the transfer code', async () => {
    const store = new PrismaProfileStore(() => db.prisma);
    const p = await store.create('Dana');
    const issued = await store.issueTransferCode(p.deviceKey, Date.now(), 60_000);
    const rows = await db.query('SELECT * FROM profiles');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(p.deviceKey);
    expect(dump).not.toContain(issued!.code);
    expect(rows[0]).toMatchObject({ nickname: 'Dana', rating: 1000, games: 0 });
  });
});

describe('PrismaProfileStore without a database', () => {
  it('no client (disabled or down) → RatingsUnavailableError', async () => {
    await expect(new PrismaProfileStore(() => null).create('x')).rejects.toThrow(/unavailable/);
  });
});
