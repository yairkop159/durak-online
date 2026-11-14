import { useEffect, useRef, useState } from 'react';
import { enqueueMoments, MOMENT_BANNER_MS, type Moment } from '../anim/moments';
import type { BoardAnimation } from '../anim/useBoardAnimation';
import { MOMENT_SOUNDS } from '../audio/soundPlan';
import { useAudio } from '../settings/react';

export interface ActiveMoment {
  readonly id: number;
  readonly moment: Moment;
  /** How long its banner stays up. */
  readonly durationMs: number;
}

interface Queued {
  readonly id: number;
  readonly moment: Moment;
  /** Local time (ms) when it may appear. */
  readonly readyAt: number;
}

/**
 * One banner at a time. Each animated version adds its moments (timed after their animation),
 * a banner outlives the state that caused it (the next move can arrive while it is up), and
 * the queue holds at most a few, dropping the least important. Plays the moment's sound when
 * its banner appears. `enabled = false` (game over, reconnecting) clears everything.
 */
export function useMomentQueue(anim: BoardAnimation, { speed, enabled }: { speed: number; enabled: boolean }): ActiveMoment | null {
  const audio = useAudio();
  const [active, setActive] = useState<ActiveMoment | null>(null);
  const [queue, setQueue] = useState<readonly Queued[]>([]);
  const nextId = useRef(1);
  const seenVersion = useRef(anim.version);

  // New moments from each new version.
  useEffect(() => {
    if (anim.version === seenVersion.current) return;
    seenVersion.current = anim.version;
    if (!enabled || anim.moments.length === 0) return;
    const now = Date.now();
    const incoming = anim.moments.map(({ moment, atMs }) => ({ id: nextId.current++, moment, readyAt: now + atMs }));
    setQueue((q) => enqueueMoments(q, incoming));
  }, [anim, enabled]);

  useEffect(() => {
    if (enabled) return;
    setQueue([]);
    setActive(null);
  }, [enabled]);

  // Show the head of the queue when nothing is up and it is ready.
  useEffect(() => {
    if (active || queue.length === 0) return;
    const head = queue[0]!;
    const timer = setTimeout(
      () => {
        setQueue((q) => q.filter((x) => x.id !== head.id));
        setActive({ id: head.id, moment: head.moment, durationMs: Math.round(MOMENT_BANNER_MS * speed) });
        audio.play(MOMENT_SOUNDS[head.moment.type]);
      },
      Math.max(0, head.readyAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [active, queue, speed, audio]);

  // Take it down after its time.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setActive((a) => (a?.id === active.id ? null : a)), active.durationMs);
    return () => clearTimeout(timer);
  }, [active]);

  return active;
}
