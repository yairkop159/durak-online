import { useSyncExternalStore } from 'react';

export type Route = { readonly name: 'home' } | { readonly name: 'room'; readonly roomId: string };

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{4,32})\/?$/;

export function parseRoute(pathname: string): Route {
  const match = ROOM_PATH.exec(pathname);
  return match?.[1] ? { name: 'room', roomId: match[1] } : { name: 'home' };
}

export function roomPath(roomId: string): string {
  return `/room/${roomId}`;
}

export function roomUrl(roomId: string, origin: string = window.location.origin): string {
  return `${origin}${roomPath(roomId)}`;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  for (const listener of [...listeners]) listener();
}

const getPath = () => window.location.pathname;

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath, getPath);
  return parseRoute(path);
}
