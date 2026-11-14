import type { MyProfile, ProfileCredentials } from '@durak/shared';

/** Postgres is not configured or not reachable: profiles and ratings are off (games still run). */
export class RatingsUnavailableError extends Error {
  constructor(message = 'ratings unavailable') {
    super(message);
    this.name = 'RatingsUnavailableError';
  }
}

export interface IssuedTransferCode {
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * Device profiles (Phase 10). Every method may throw RatingsUnavailableError (or a driver error)
 * when Postgres is down; callers on the game path must never let that reach a game.
 */
export interface ProfileStore {
  create(nickname: string): Promise<ProfileCredentials>;
  /** The profile a device key belongs to, or null (unknown or revoked key). */
  resolveKey(deviceKey: string): Promise<MyProfile | null>;
  rename(deviceKey: string, nickname: string): Promise<MyProfile | null>;
  /** A fresh one-time code (replaces any open one), or null for an unknown key. */
  issueTransferCode(deviceKey: string, now: number, ttlMs: number): Promise<IssuedTransferCode | null>;
  /**
   * Moves the profile to the claiming device: a new device key is issued and the old one stops
   * working. Null for an unknown, expired or used code.
   */
  claim(code: string, now: number): Promise<ProfileCredentials | null>;
}
