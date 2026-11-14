import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../i18n';
import { browserLocalStorage } from '../settings/settings';
import { ProfileApi } from './api';
import { ProfileStore, type DeviceProfile } from './profileStore';

export interface Profiles {
  readonly store: ProfileStore;
  readonly api: ProfileApi;
  /**
   * In the background (Home and the join prompt call it on mount): makes sure this device has a
   * profile the server still knows. Creates one (with a placeholder nickname, renamed on the
   * first game) if there is none, and replaces one whose key was revoked (moved to another
   * device). Never throws; offline or ratings down → nothing happens.
   */
  prepare(): Promise<void>;
  /**
   * The device key to seat with, synchronously (a click never waits for the network), or
   * undefined = an unrated seat. Syncs a changed nickname in the background.
   */
  seatKey(nickname: string): string | undefined;
}

export function createProfiles(store: ProfileStore, api: ProfileApi): Profiles {
  let preparing: Promise<void> | null = null;

  const createNew = async (nickname: string) => {
    const created = await api.create(nickname);
    if (created.ok) store.set(created.value);
  };

  const prepare = async () => {
    const current = store.get();
    if (!current) return createNew(t.profile.defaultNickname);
    const me = await api.me(current.deviceKey);
    if (me.ok) {
      if (me.value.nickname !== current.nickname) store.set({ ...current, nickname: me.value.nickname });
      return;
    }
    if (me.error === 'UNAUTHORIZED' && store.get()?.deviceKey === current.deviceKey) {
      store.set(null); // moved to another device: this one starts afresh
      await createNew(current.nickname);
    }
  };

  return {
    store,
    api,
    prepare() {
      preparing ??= prepare()
        .catch(() => undefined)
        .finally(() => (preparing = null));
      return preparing;
    },
    seatKey(nickname) {
      const current = store.get();
      if (!current) return undefined;
      if (current.nickname !== nickname) {
        store.set({ ...current, nickname });
        void api.rename(current.deviceKey, nickname).catch(() => undefined);
      }
      return current.deviceKey;
    },
  };
}

const ProfilesContext = createContext<Profiles | null>(null);

/** `profiles` is injectable for tests (default: localStorage + the server's /api). */
export function ProfilesProvider({ profiles, children }: { profiles?: Profiles; children: ReactNode }) {
  const [value] = useState<Profiles>(() => profiles ?? createProfiles(new ProfileStore(browserLocalStorage()), new ProfileApi()));
  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): Profiles {
  const value = useContext(ProfilesContext);
  if (!value) throw new Error('useProfiles outside <ProfilesProvider>');
  return value;
}

export function useDeviceProfile(): DeviceProfile | null {
  const { store } = useProfiles();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
