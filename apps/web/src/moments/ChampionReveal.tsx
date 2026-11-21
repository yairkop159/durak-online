import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { anchorKey, useAnchorRegistry, type Rect } from '../anim/anchors';
import type { ChampionPlan } from '../anim/championReveal';
import { t } from '../i18n';
import { useAudio, useHaptic } from '../settings/react';

type Stage = 'dim' | 'spot' | 'stamp';

function center(rect: Rect | null): { x: number; y: number } {
  if (!rect || rect.width === 0) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The tournament's champion moment (after the last game's durak reveal): dim, a spotlight on each
 * champion's seat, then the "אלוף הטורניר!" stamp in the middle with the champion line. Like
 * DurakReveal, every visual is pointer-events: none and the only interactive layer is the
 * full-screen tap-to-skip button (the game is over: there is no move to block).
 */
export function ChampionReveal({ plan, caption, onDone }: { plan: ChampionPlan; caption: string; onDone: () => void }) {
  const registry = useAnchorRegistry();
  const audio = useAudio();
  const haptic = useHaptic();
  const [stage, setStage] = useState<Stage>('dim');
  const spots = useMemo(() => plan.seats.map((id) => center(registry.live(anchorKey.seat(id)))), [plan, registry]);

  useEffect(() => {
    audio.play('win', plan.stampAtMs);
    const timers = [
      setTimeout(() => setStage('spot'), plan.dimMs),
      setTimeout(() => {
        setStage('stamp');
        haptic('win');
      }, plan.stampAtMs),
      setTimeout(onDone, plan.totalMs),
    ];
    return () => timers.forEach(clearTimeout);
    // Runs once per plan.
  }, [plan]);

  return (
    <div className="fixed inset-0 z-40" data-testid="champion-reveal" data-stage={stage}>
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-black/65"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: plan.dimMs / 1000 }}
      />
      {stage !== 'dim' &&
        spots.map((s, i) => (
          <motion.div
            key={i}
            aria-hidden="true"
            className="pointer-events-none absolute size-40 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: s.x, top: s.y, background: 'radial-gradient(circle, rgba(250,204,21,0.38) 0%, rgba(250,204,21,0.1) 45%, transparent 70%)' }}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: plan.spotMs / 1000, ease: 'easeOut' }}
          />
        ))}
      {stage === 'stamp' && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 flex w-[min(90vw,24rem)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center"
        >
          <motion.span
            className="text-6xl"
            initial={{ y: 30, opacity: 0, scale: 0.5 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 14 }}
          >
            🏆
          </motion.span>
          <motion.span
            className="rounded-xl px-3 py-1 text-4xl font-black text-accent ring-4 ring-accent/70"
            initial={{ scale: 2.6, opacity: 0, rotate: 12 }}
            animate={{ scale: 1, opacity: 1, rotate: 3 }}
            transition={{ type: 'spring', stiffness: 420, damping: 16 }}
          >
            {t.tournament.stamp}
          </motion.span>
          <span className="text-lg font-bold text-white drop-shadow" data-testid="champion-caption">
            {caption}
          </span>
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        {stage === 'stamp' ? caption : ''}
      </div>
      <button
        type="button"
        data-testid="champion-skip"
        aria-label={t.reveal.skip}
        onClick={onDone}
        className="absolute inset-0 h-full w-full cursor-pointer bg-transparent"
      />
    </div>
  );
}
