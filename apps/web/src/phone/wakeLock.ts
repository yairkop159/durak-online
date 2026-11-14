/**
 * Keeps the screen on while a game runs (Screen Wake Lock API). The browser drops the lock
 * whenever the page is hidden, so it is requested again when the page becomes visible while still
 * wanted. A no-op where the API is missing (older browsers, http:// on a LAN IP: it needs HTTPS or
 * localhost); every failure is swallowed (e.g. low battery mode refuses it).
 */
import { useEffect, useState } from 'react';

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockNavigator {
  readonly wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ScreenWakeLock {
  readonly supported: boolean;
  /** Wanted or not; acquires (when visible) or releases. */
  setActive(active: boolean): void;
  /** True while the browser holds a lock for us. */
  held(): boolean;
  dispose(): void;
}

export function createWakeLock(nav: WakeLockNavigator, doc: VisibilityDocument): ScreenWakeLock {
  const api = nav.wakeLock;
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = false;
  let disposed = false;

  const acquire = () => {
    if (!api || !wanted || disposed || pending || (sentinel && !sentinel.released) || doc.visibilityState !== 'visible') return;
    pending = true;
    api
      .request('screen')
      .then((s) => {
        pending = false;
        // Unwanted while the request was in flight: give it back at once.
        if (!wanted || disposed) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      })
      .catch(() => {
        pending = false;
      });
  };

  const release = () => {
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) void s.release().catch(() => {});
  };

  const onVisibility = () => {
    if (doc.visibilityState === 'visible') acquire();
  };
  if (api) doc.addEventListener('visibilitychange', onVisibility);

  return {
    supported: !!api,
    setActive(active) {
      wanted = active;
      if (active) acquire();
      else release();
    },
    held: () => !!sentinel && !sentinel.released,
    dispose() {
      disposed = true;
      wanted = false;
      release();
      if (api) doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/** Holds a screen wake lock while `active` (e.g. a game is running). */
export function useWakeLock(active: boolean): void {
  const [lock] = useState(() =>
    typeof navigator !== 'undefined' && typeof document !== 'undefined' ? createWakeLock(navigator as WakeLockNavigator, document) : null,
  );
  useEffect(() => {
    lock?.setActive(active);
  }, [lock, active]);
  useEffect(() => () => lock?.dispose(), [lock]);
}
