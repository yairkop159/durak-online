import { DeviceKeySchema, NicknameSchema, ProfileIdSchema } from '@durak/shared';
import type { KeyValueStorage } from '../net/sessionStore';

/**
 * The device's profile (Phase 10): a random public id, the secret device key the server knows
 * only as a hash, and the last nickname. No email, no password. Kept in localStorage — unlike
 * session tokens (sessionStorage, one per tab), the profile is the person, shared by every tab
 * (the server seats a profile at most once per room).
 */
export interface DeviceProfile {
  readonly v: 1;
  readonly profileId: string;
  readonly deviceKey: string;
  readonly nickname: string;
}

export const PROFILE_KEY = 'durak:profile';

/** Never throws: anything malformed reads as "no profile". */
export function parseProfile(raw: string | null): DeviceProfile | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { v, profileId, deviceKey, nickname } = data as Record<string, unknown>;
  if (v !== 1) return null;
  if (!ProfileIdSchema.safeParse(profileId).success || !DeviceKeySchema.safeParse(deviceKey).success) return null;
  const name = NicknameSchema.safeParse(nickname);
  if (!name.success) return null;
  return { v: 1, profileId: profileId as string, deviceKey: deviceKey as string, nickname: name.data };
}

type Listener = () => void;

/** External store (`useSyncExternalStore`); every storage access is guarded (private mode, quota). */
export class ProfileStore {
  private profile: DeviceProfile | null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: KeyValueStorage | null) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(PROFILE_KEY) ?? null;
    } catch {
      raw = null;
    }
    this.profile = parseProfile(raw);
  }

  get = (): DeviceProfile | null => this.profile;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(profile: Omit<DeviceProfile, 'v'> | null): void {
    this.profile = profile ? { v: 1, ...profile } : null;
    try {
      if (this.profile) this.storage?.setItem(PROFILE_KEY, JSON.stringify(this.profile));
      else this.storage?.removeItem(PROFILE_KEY);
    } catch {
      // Storage blocked: the profile lives for this page only.
    }
    for (const listener of [...this.listeners]) listener();
  }
}
