import { createContext, useContext, type ReactNode } from 'react';
import type { Schedule } from './driver';
import { tutorialProgress, type ProgressStore } from './progress';

/** What the tutorial screens use from the outside world; injectable (`App tutorial={…}`) for tests. */
export interface TutorialEnv {
  readonly progress: ProgressStore;
  /** Opponent pacing (default: setTimeout). */
  readonly schedule?: Schedule;
  /** The free practice game's deal (default: a random seed). */
  readonly practiceSeed: () => number;
}

const randomSeed = (): number => {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0;
  } catch {
    return Math.floor(Math.random() * 2 ** 32);
  }
};

const TutorialContext = createContext<TutorialEnv | null>(null);

export function TutorialProvider({ env, children }: { env?: Partial<TutorialEnv>; children: ReactNode }) {
  const value: TutorialEnv = {
    progress: env?.progress ?? tutorialProgress(),
    practiceSeed: env?.practiceSeed ?? randomSeed,
    ...(env?.schedule ? { schedule: env.schedule } : {}),
  };
  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}

export function useTutorialEnv(): TutorialEnv {
  return useContext(TutorialContext) ?? { progress: tutorialProgress(), practiceSeed: randomSeed };
}
