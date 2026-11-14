import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeviceKeySchema, ProfileIdSchema } from '@durak/shared';
import type { ProfileStore } from '../../src/ratings/ports.js';

const T0 = 1_700_000_000_000;
const TTL = 10 * 60_000;

/** The same behaviour from every ProfileStore (in-memory for tests, Postgres in production). */
export function profileStoreContract(name: string, make: () => Promise<{ store: ProfileStore; cleanup: () => Promise<void> }>) {
  describe(`ProfileStore contract: ${name}`, () => {
    let store: ProfileStore;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ store, cleanup } = await make());
    }, 60_000);
    afterAll(async () => cleanup?.());

    it('create issues a public id and a secret key; the key resolves to the profile', async () => {
      const created = await store.create('Dana');
      expect(ProfileIdSchema.safeParse(created.profileId).success).toBe(true);
      expect(DeviceKeySchema.safeParse(created.deviceKey).success).toBe(true);
      expect(await store.resolveKey(created.deviceKey)).toEqual({ profileId: created.profileId, nickname: 'Dana' });
      expect(await store.resolveKey('A'.repeat(43))).toBeNull();
    });

    it('rename changes the nickname; an unknown key renames nothing', async () => {
      const { deviceKey, profileId } = await store.create('Old');
      expect(await store.rename(deviceKey, 'New')).toEqual({ profileId, nickname: 'New' });
      expect(await store.resolveKey(deviceKey)).toEqual({ profileId, nickname: 'New' });
      expect(await store.rename('B'.repeat(43), 'X')).toBeNull();
    });

    it('a transfer code moves the profile: new key works, old key is revoked, the code works once', async () => {
      const old = await store.create('Mover');
      const issued = await store.issueTransferCode(old.deviceKey, T0, TTL);
      expect(issued?.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(issued?.expiresAt).toBe(T0 + TTL);

      const claimed = await store.claim(issued!.code, T0 + 1000);
      expect(claimed).toMatchObject({ profileId: old.profileId, nickname: 'Mover' });
      expect(claimed!.deviceKey).not.toBe(old.deviceKey);
      expect(await store.resolveKey(claimed!.deviceKey)).toEqual({ profileId: old.profileId, nickname: 'Mover' });
      expect(await store.resolveKey(old.deviceKey)).toBeNull();
      expect(await store.claim(issued!.code, T0 + 2000)).toBeNull(); // single use
    });

    it('an expired code does not work; a new code replaces the previous one', async () => {
      const p = await store.create('Late');
      const first = await store.issueTransferCode(p.deviceKey, T0, TTL);
      const second = await store.issueTransferCode(p.deviceKey, T0, TTL);
      expect(await store.claim(first!.code, T0 + 1)).toBeNull();
      expect(await store.claim(second!.code, T0 + TTL)).toBeNull(); // expiry is exclusive
      const third = await store.issueTransferCode(p.deviceKey, T0 + TTL, TTL);
      expect(await store.claim(third!.code, T0 + TTL + 1)).not.toBeNull();
    });

    it('an unknown key gets no transfer code', async () => {
      expect(await store.issueTransferCode('C'.repeat(43), T0, TTL)).toBeNull();
    });
  });
}
