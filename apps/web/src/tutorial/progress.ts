import { useSyncExternalStore } from 'react';
import type { KeyValueStorage } from '../net/sessionStore';
import { browserLocalStorage } from '../settings/settings';
import { BASICS, LESSON_IDS, type LessonId } from './lessons';

/**
 * Tutorial progress, per device in localStorage (never sent to the server).
 * `offerSeen`: Home's one-time "new to Durak?" card was answered (start or not now).
 */
export interface TutorialProgress {
  readonly v: 1;
  readonly completed: readonly LessonId[];
  readonly offerSeen: boolean;
}

export const TUTORIAL_KEY = 'durak:tutorial';
export const DEFAULT_PROGRESS: TutorialProgress = { v: 1, completed: [], offerSeen: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Field by field: anything missing or invalid falls back to its default (never throws). */
export function parseProgress(raw: string | null): TutorialProgress {
  if (raw === null) return DEFAULT_PROGRESS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_PROGRESS;
  }
  if (!isRecord(data)) return DEFAULT_PROGRESS;
  const completed = Array.isArray(data.completed) ? LESSON_IDS.filter((id) => (data.completed as unknown[]).includes(id)) : [];
  return { v: 1, completed, offerSeen: typeof data.offerSeen === 'boolean' ? data.offerSeen : false };
}

/** The free practice game opens once every basics lesson is done. */
export const practiceUnlocked = (p: TutorialProgress): boolean => BASICS.every((id) => p.completed.includes(id));

type Listener = () => void;

export class ProgressStore {
  private progress: TutorialProgress;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: KeyValueStorage | null) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(TUTORIAL_KEY) ?? null;
    } catch {
      raw = null; // storage blocked: in memory only
    }
    this.progress = parseProgress(raw);
  }

  get = (): TutorialProgress => this.progress;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(next: TutorialProgress): void {
    if (next === this.progress) return;
    this.progress = next;
    try {
      this.storage?.setItem(TUTORIAL_KEY, JSON.stringify(next));
    } catch {
      // Private mode / quota: keep it for this page only.
    }
    for (const listener of [...this.listeners]) listener();
  }

  complete(id: LessonId): void {
    const p = this.progress;
    if (!p.completed.includes(id)) this.update({ ...p, completed: LESSON_IDS.filter((l) => l === id || p.completed.includes(l)) });
  }

  markOfferSeen(): void {
    if (!this.progress.offerSeen) this.update({ ...this.progress, offerSeen: true });
  }
}

let shared: ProgressStore | null = null;
/** The app's store (localStorage); created on first use. */
export function tutorialProgress(): ProgressStore {
  shared ??= new ProgressStore(browserLocalStorage());
  return shared;
}
/** Tests: forget the shared store (the next use re-reads storage). */
export function resetTutorialProgressForTests(): void {
  shared = null;
}

export function useTutorialProgress(store: ProgressStore = tutorialProgress()): TutorialProgress {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
