import type { MyProfile, ProfileCredentials } from '@durak/shared';
import type { PrismaClient } from '../db/database.js';
import { newDeviceKey, newProfileId, newTransferCode, secretHash } from './credentials.js';
import { RatingsUnavailableError, type IssuedTransferCode, type ProfileStore } from './ports.js';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Profiles in Postgres. `client()` is null while the database is disabled or down. */
export class PrismaProfileStore implements ProfileStore {
  constructor(private readonly client: () => PrismaClient | null) {}

  protected db(): PrismaClient {
    const client = this.client();
    if (!client) throw new RatingsUnavailableError();
    return client;
  }

  async create(nickname: string): Promise<ProfileCredentials> {
    const deviceKey = newDeviceKey();
    const profile = await this.db().profile.create({
      data: { id: newProfileId(), nickname, deviceKeyHash: secretHash(deviceKey) },
      select: { id: true, nickname: true },
    });
    return { profileId: profile.id, deviceKey, nickname: profile.nickname };
  }

  async resolveKey(deviceKey: string): Promise<MyProfile | null> {
    const profile = await this.db().profile.findUnique({
      where: { deviceKeyHash: secretHash(deviceKey) },
      select: { id: true, nickname: true },
    });
    return profile ? { profileId: profile.id, nickname: profile.nickname } : null;
  }

  async rename(deviceKey: string, nickname: string): Promise<MyProfile | null> {
    const { count } = await this.db().profile.updateMany({
      where: { deviceKeyHash: secretHash(deviceKey) },
      data: { nickname },
    });
    return count === 1 ? this.resolveKey(deviceKey) : null;
  }

  async issueTransferCode(deviceKey: string, now: number, ttlMs: number): Promise<IssuedTransferCode | null> {
    const expiresAt = now + ttlMs;
    // A 40-bit code colliding with another open code is unlikely; retry a few times if it does.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newTransferCode();
      try {
        const { count } = await this.db().profile.updateMany({
          where: { deviceKeyHash: secretHash(deviceKey) },
          data: { transferCodeHash: secretHash(code), transferExpiresAt: new Date(expiresAt) },
        });
        return count === 1 ? { code, expiresAt } : null;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('could not issue a unique transfer code');
  }

  async claim(code: string, now: number): Promise<ProfileCredentials | null> {
    const codeHash = secretHash(code);
    const deviceKey = newDeviceKey();
    // One conditional UPDATE: the code must still be open and unexpired, so two devices racing for
    // the same code cannot both win, and the old device key stops working in the same statement.
    const { count } = await this.db().profile.updateMany({
      where: { transferCodeHash: codeHash, transferExpiresAt: { gt: new Date(now) } },
      data: { deviceKeyHash: secretHash(deviceKey), transferCodeHash: null, transferExpiresAt: null },
    });
    if (count !== 1) return null;
    const profile = await this.resolveKey(deviceKey);
    return profile ? { ...profile, deviceKey } : null;
  }
}
