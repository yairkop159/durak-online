import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library can't register its own auto-cleanup.
// Recent Node versions define their own global `localStorage`, which shadows jsdom's and is
// unusable without --localstorage-file. Give tests a working in-memory one.
function usableLocalStorage(): boolean {
  try {
    return typeof window.localStorage?.getItem === 'function';
  } catch {
    return false;
  }
}
if (typeof window !== 'undefined' && !usableLocalStorage()) {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

afterEach(() => {
  cleanup();
  // Settings live in localStorage: every test starts from the defaults.
  if (typeof window !== 'undefined') window.localStorage.clear();
});

// Animations complete instantly in tests (state is never gated on them anyway).
MotionGlobalConfig.skipAnimations = true;

// jsdom has no matchMedia; Framer's useReducedMotion reads it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
