import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library can't register its own auto-cleanup.
afterEach(() => cleanup());

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
