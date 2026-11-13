/** Injectable time source, so tests can run timers on fake time. */
export interface Clock {
  now(): number;
}

export type TimerHandle = { readonly id: number };

/** Runs `fn` at (or as soon as possible after) epoch-ms `at`. */
export interface Scheduler {
  schedule(at: number, fn: () => Promise<void>): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export const systemClock: Clock = { now: () => Date.now() };

/** setTimeout-based scheduler. Errors from callbacks are reported, never thrown. */
export function createSystemScheduler(clock: Clock, onError: (error: unknown) => void): Scheduler {
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    schedule(at, fn) {
      const id = nextId++;
      const delay = Math.max(0, at - clock.now());
      // setTimeout caps delays at ~24.8 days; deadlines here are seconds to minutes.
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          fn().catch(onError);
        }, delay),
      );
      return { id };
    },
    cancel(handle) {
      const timer = timers.get(handle.id);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(handle.id);
    },
  };
}
