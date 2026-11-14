import type { KeyValueStorage } from '../net/sessionStore';

/** First-game tips (Part 4); remembered once dismissed. */
export const TIP_IDS = ['firstAttack', 'firstDefense', 'firstThrowIn', 'firstTransfer'] as const;
export type TipId = (typeof TIP_IDS)[number];

export type AnimationSpeed = 'normal' | 'fast';

/**
 * Per-device preferences, kept in localStorage (never sent to the server).
 * v2 (Phase 8) added `showReactions`; v1 data is read field by field with the new default.
 */
export interface Settings {
  readonly v: 2;
  readonly sfx: { readonly enabled: boolean; readonly volume: number };
  readonly music: { readonly enabled: boolean; readonly volume: number };
  readonly animationSpeed: AnimationSpeed;
  readonly showTips: boolean;
  readonly tipsSeen: readonly TipId[];
  /** Show other players' quick reactions (bubbles + sound) and my reaction button. */
  readonly showReactions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 2,
  sfx: { enabled: true, volume: 0.7 },
  music: { enabled: false, volume: 0.35 },
  animationSpeed: 'normal',
  showTips: true,
  tipsSeen: [],
  showReactions: true,
};

/** Multiplier for every animation duration (reduced motion still wins over it). */
export const ANIMATION_SPEED_FACTOR: Record<AnimationSpeed, number> = { normal: 1, fast: 0.6 };

export const SETTINGS_KEY = 'durak:settings';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const volume = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

function channel(v: unknown, fallback: Settings['sfx']): Settings['sfx'] {
  if (!isRecord(v)) return fallback;
  return { enabled: bool(v.enabled, fallback.enabled), volume: volume(v.volume, fallback.volume) };
}

/**
 * Field by field: anything missing or invalid falls back to its default (never throws). Any older
 * version is migrated the same way (a field it lacks gets its default).
 */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isRecord(data)) return DEFAULT_SETTINGS;
  const d = DEFAULT_SETTINGS;
  return {
    v: 2,
    sfx: channel(data.sfx, d.sfx),
    music: channel(data.music, d.music),
    animationSpeed: data.animationSpeed === 'fast' || data.animationSpeed === 'normal' ? data.animationSpeed : d.animationSpeed,
    showTips: bool(data.showTips, d.showTips),
    tipsSeen: Array.isArray(data.tipsSeen)
      ? TIP_IDS.filter((id) => (data.tipsSeen as unknown[]).includes(id))
      : d.tipsSeen,
    showReactions: bool(data.showReactions, d.showReactions),
  };
}

type Listener = () => void;

/** External store for the settings (`useSyncExternalStore`), persisted on every change. */
export class SettingsStore {
  private settings: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: KeyValueStorage | null) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(SETTINGS_KEY) ?? null;
    } catch {
      raw = null; // storage blocked: defaults, in memory only
    }
    this.settings = parseSettings(raw);
  }

  get = (): Settings => this.settings;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(change: (s: Settings) => Settings): void {
    const next = change(this.settings);
    if (next === this.settings) return;
    this.settings = next;
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Private mode / quota: keep the change for this page only.
    }
    for (const listener of [...this.listeners]) listener();
  }

  markTipSeen(id: TipId): void {
    this.update((s) => (s.tipsSeen.includes(id) ? s : { ...s, tipsSeen: [...s.tipsSeen, id] }));
  }
}

/** localStorage, or null when the browser blocks it. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
