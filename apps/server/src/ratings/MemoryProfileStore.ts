import type { MyProfile, ProfileCredentials } from '@durak/shared';
import { newDeviceKey, newProfileId, newTransferCode, secretHash } from './credentials.js';
import { RatingsUnavailableError, type IssuedTransferCode, type ProfileStore } from './ports.js';

export interface MemoryProfile {
  id: string;
  nickname: string;
  deviceKeyHash: string;
  transferCodeHash: string | null;
  transferExpiresAt: number | null;
}

/**
 * In-memory profiles with the same semantics as PrismaProfileStore, for service and socket tests
 * that must not need Postgres. `available = false` simulates an outage.
 */
export class MemoryProfileStore implements ProfileStore {
  readonly profiles = new Map<string, MemoryProfile>();
  available = true;

  private check(): void {
    if (!this.available) throw new RatingsUnavailableError();
  }

  private byKey(deviceKey: string): MemoryProfile | undefined {
    const hash = secretHash(deviceKey);
    return [...this.profiles.values()].find((p) => p.deviceKeyHash === hash);
  }

  async create(nickname: string): Promise<ProfileCredentials> {
    this.check();
    const deviceKey = newDeviceKey();
    const id = newProfileId();
    this.profiles.set(id, { id, nickname, deviceKeyHash: secretHash(deviceKey), transferCodeHash: null, transferExpiresAt: null });
    return { profileId: id, deviceKey, nickname };
  }

  async resolveKey(deviceKey: string): Promise<MyProfile | null> {
    this.check();
    const profile = this.byKey(deviceKey);
    return profile ? { profileId: profile.id, nickname: profile.nickname } : null;
  }

  async rename(deviceKey: string, nickname: string): Promise<MyProfile | null> {
    this.check();
    const profile = this.byKey(deviceKey);
    if (!profile) return null;
    profile.nickname = nickname;
    return { profileId: profile.id, nickname };
  }

  async issueTransferCode(deviceKey: string, now: number, ttlMs: number): Promise<IssuedTransferCode | null> {
    this.check();
    const profile = this.byKey(deviceKey);
    if (!profile) return null;
    const code = newTransferCode();
    profile.transferCodeHash = secretHash(code);
    profile.transferExpiresAt = now + ttlMs;
    return { code, expiresAt: now + ttlMs };
  }

  async claim(code: string, now: number): Promise<ProfileCredentials | null> {
    this.check();
    const hash = secretHash(code);
    const profile = [...this.profiles.values()].find(
      (p) => p.transferCodeHash === hash && p.transferExpiresAt !== null && p.transferExpiresAt > now,
    );
    if (!profile) return null;
    const deviceKey = newDeviceKey();
    profile.deviceKeyHash = secretHash(deviceKey);
    profile.transferCodeHash = null;
    profile.transferExpiresAt = null;
    return { profileId: profile.id, deviceKey, nickname: profile.nickname };
  }
}
