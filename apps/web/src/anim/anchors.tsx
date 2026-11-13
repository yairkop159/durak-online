import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Named screen positions that flights travel between: `deck`, `trump`, `discard`, `seat:<id>`,
 * `card:<cardId>` (face-up cards only). Rects are snapshotted after every commit so a flight can
 * start where a card *was* (e.g. a table card that has just been swept away).
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type RefCallback = (element: HTMLElement | null) => void;

export class AnchorRegistry {
  private readonly elements = new Map<string, HTMLElement>();
  private readonly cached = new Map<string, Rect>();
  private readonly callbacks = new Map<string, RefCallback>();

  /** A stable ref callback per key (so React doesn't detach/re-attach on every render). */
  ref(key: string): RefCallback {
    let callback = this.callbacks.get(key);
    if (!callback) {
      callback = (element) => {
        if (element) this.elements.set(key, element);
        else this.elements.delete(key);
      };
      this.callbacks.set(key, callback);
    }
    return callback;
  }

  /** Where the anchor is now (mounted elements only). */
  live(key: string): Rect | null {
    const element = this.elements.get(key);
    return element?.isConnected ? toRect(element.getBoundingClientRect()) : null;
  }

  /** Where the anchor was at the previous commit (works for elements that are gone now). */
  previous(key: string): Rect | null {
    return this.cached.get(key) ?? null;
  }

  /** Live if mounted, else the last known position. */
  any(key: string): Rect | null {
    return this.live(key) ?? this.previous(key);
  }

  snapshot(): void {
    for (const [key, element] of this.elements) {
      if (element.isConnected) this.cached.set(key, toRect(element.getBoundingClientRect()));
    }
  }
}

function toRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const AnchorContext = createContext<AnchorRegistry | null>(null);

export function AnchorProvider({ registry, children }: { registry: AnchorRegistry; children: ReactNode }) {
  return <AnchorContext.Provider value={registry}>{children}</AnchorContext.Provider>;
}

export function useAnchorRegistry(): AnchorRegistry {
  const registry = useContext(AnchorContext);
  // Outside a provider (isolated component tests) anchors are simply not tracked.
  return useMemo(() => registry ?? new AnchorRegistry(), [registry]);
}

/** Ref callback registering the element under `key`. */
export function useAnchor(key: string): RefCallback {
  return useAnchorRegistry().ref(key);
}

export const anchorKey = {
  deck: 'deck',
  trump: 'trump',
  discard: 'discard',
  seat: (playerId: string) => `seat:${playerId}`,
  card: (cardId: string) => `card:${cardId}`,
} as const;
