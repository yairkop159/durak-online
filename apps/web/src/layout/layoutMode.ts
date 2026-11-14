import { useSyncExternalStore } from 'react';

/**
 * How the table screen is laid out:
 * - `regular`: tablets and desktops.
 * - `phone`: a narrow portrait screen (compact seats, the deck/discard as a strip above the table).
 * - `short`: a short landscape screen, e.g. a phone on its side (opponents in the top bar, my seat,
 *   the status and Take/Pass beside the hand). Height is the scarce dimension there.
 */
export type LayoutMode = 'regular' | 'phone' | 'short';

export const PHONE_MAX_WIDTH = 639;
export const SHORT_MAX_HEIGHT = 500;

export function layoutModeFor(width: number, height: number): LayoutMode {
  if (height <= SHORT_MAX_HEIGHT && width > height) return 'short';
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  return 'regular';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}

const snapshot = (): LayoutMode => layoutModeFor(window.innerWidth, window.innerHeight);

/** The current layout mode; follows resizes and rotations. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, snapshot, () => 'regular');
}
