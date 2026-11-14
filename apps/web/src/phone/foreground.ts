/**
 * Coming back to the app (phone unlocked, switched back from another app, restored from the
 * back/forward cache, network back): tells the client how long it was away so it resyncs at once
 * (GameClient.resyncNow).
 */
export interface ForegroundTarget {
  resyncNow(hiddenMs: number): void;
}

export interface ForegroundEnv {
  readonly doc: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  readonly win: {
    addEventListener(type: 'pageshow' | 'online', listener: (event: Event) => void): void;
    removeEventListener(type: 'pageshow' | 'online', listener: (event: Event) => void): void;
  };
  readonly now: () => number;
}

/** Starts watching; returns the function that stops. */
export function watchForeground(target: ForegroundTarget, env: ForegroundEnv): () => void {
  const { doc, win, now } = env;
  let hiddenAt: number | null = doc.visibilityState === 'hidden' ? now() : null;
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      hiddenAt ??= now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    target.resyncNow(away);
  };
  // Restored from the back/forward cache: the page was frozen, its socket is certainly gone.
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) target.resyncNow(Number.POSITIVE_INFINITY);
  };
  // The network came back (or changed, e.g. Wi-Fi -> cellular): the old socket is likely dead.
  const onOnline = () => target.resyncNow(Number.POSITIVE_INFINITY);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
  };
}
