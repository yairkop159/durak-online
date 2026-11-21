import { useSyncExternalStore } from 'react';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'rules' }
  | { readonly name: 'room'; readonly roomId: string }
  /** /profile = mine (profileId null), /profile/:id = someone's public profile. */
  | { readonly name: 'profile'; readonly profileId: string | null }
  | { readonly name: 'leaderboard' }
  /** /tutorial = the menu (lesson null), /tutorial/:lesson = a lesson or `practice` (validated by the screen). */
  | { readonly name: 'tutorial'; readonly lesson: string | null };

export const RULES_PATH = '/rules';
export const PROFILE_PATH = '/profile';
export const LEADERBOARD_PATH = '/leaderboard';
export const TUTORIAL_PATH = '/tutorial';

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{4,32})\/?$/;
const PROFILE_ID_PATH = /^\/profile\/([A-Za-z0-9_-]{22})\/?$/;
const TUTORIAL_LESSON_PATH = /^\/tutorial\/([a-z][a-z-]{1,23})\/?$/;

const is = (pathname: string, path: string) => pathname === path || pathname === `${path}/`;

export function parseRoute(pathname: string): Route {
  if (is(pathname, RULES_PATH)) return { name: 'rules' };
  if (is(pathname, PROFILE_PATH)) return { name: 'profile', profileId: null };
  if (is(pathname, LEADERBOARD_PATH)) return { name: 'leaderboard' };
  if (is(pathname, TUTORIAL_PATH)) return { name: 'tutorial', lesson: null };
  const tutorial = TUTORIAL_LESSON_PATH.exec(pathname);
  if (tutorial?.[1]) return { name: 'tutorial', lesson: tutorial[1] };
  const profile = PROFILE_ID_PATH.exec(pathname);
  if (profile?.[1]) return { name: 'profile', profileId: profile[1] };
  const match = ROOM_PATH.exec(pathname);
  return match?.[1] ? { name: 'room', roomId: match[1] } : { name: 'home' };
}

export function profilePath(profileId: string): string {
  return `${PROFILE_PATH}/${profileId}`;
}

export function tutorialPath(lesson: string): string {
  return `${TUTORIAL_PATH}/${lesson}`;
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
