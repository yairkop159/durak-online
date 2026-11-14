import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { anchorKey, useAnchorRegistry, type Rect } from '../anim/anchors';
import type { RevealPlan } from '../anim/reveal';
import { CardBackFan } from '../components/cards/CardBack';
import { t } from '../i18n';
import { useAudio, useHaptic } from '../settings/react';

type Stage = 'dim' | 'sweep' | 'stamp';

function center(rect: Rect | null): { x: number; y: number } {
  if (!rect || rect.width === 0) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The end-of-game reveal: dim, a drumroll while a spotlight passes over the seats, then a stamp
 * on the durak's seat ("דוראק!") or in the middle for a draw. Everything visual is
 * pointer-events: none; the only thing that takes clicks is the full-screen tap-to-skip layer,
 * which exists only while the reveal runs (no move is possible then: the game is over).
 */
export function DurakReveal({
  plan,
  viewerId,
  nameOf,
  stinger,
  onDone,
}: {
  plan: RevealPlan;
  viewerId: string | null;
  nameOf: (id: string) => string;
  /** The win / durak stinger, played when the stamp lands (null for spectators). */
  stinger: 'win' | 'durak' | null;
  onDone: () => void;
}) {
  const registry = useAnchorRegistry();
  const audio = useAudio();
  const haptic = useHaptic();
  const [stage, setStage] = useState<Stage>('dim');
  const spots = useMemo(() => plan.sweep.map((id) => center(registry.live(anchorKey.seat(id)))), [plan, registry]);
  const target = plan.durakId !== null && plan.kind !== 'draw' ? center(registry.live(anchorKey.seat(plan.durakId))) : center(null);

  useEffect(() => {
    if (plan.sweepMs > 0) audio.play('drumroll', plan.dimMs);
    if (stinger) audio.play(stinger, plan.stampAtMs);
    const timers = [
      setTimeout(() => setStage(plan.sweepMs > 0 ? 'sweep' : 'stamp'), plan.dimMs),
      setTimeout(() => {
        setStage('stamp');
        // The buzz lands with the stamp and the stinger.
        if (stinger) haptic(stinger);
      }, plan.stampAtMs),
      setTimeout(onDone, plan.totalMs),
    ];
    return () => timers.forEach(clearTimeout);
    // Runs once per reveal: a new `onDone`/`stinger` identity must not restart it.
  }, [plan]);

  const durakName = plan.durakId !== null ? nameOf(plan.durakId) : '';
  const caption =
    plan.kind === 'draw'
      ? t.gameOver.draw
      : plan.kind === 'forfeit'
        ? t.gameOver.forfeit(durakName)
        : plan.durakId === viewerId
          ? t.gameOver.youAreDurak
          : t.gameOver.durak(durakName);

  return (
    <div className="fixed inset-0 z-40" data-testid="durak-reveal" data-stage={stage}>
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-black/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: plan.dimMs / 1000 }}
      />
      {stage === 'sweep' && spots.length > 0 && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute size-40 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.08) 45%, transparent 70%)' }}
          initial={{ left: spots[0]!.x, top: spots[0]!.y }}
          animate={{ left: spots.map((s) => s.x), top: spots.map((s) => s.y) }}
          transition={{ duration: plan.sweepMs / 1000, ease: 'easeInOut' }}
        />
      )}
      {stage === 'stamp' && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          style={{ left: target.x, top: target.y }}
        >
          <motion.div
            className="absolute size-44 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%)' }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25 }}
          />
          {plan.kind !== 'draw' && (
            <motion.div initial={{ opacity: 0, y: 10, rotate: -20 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: 0.35 }}>
              <CardBackFan count={6} />
            </motion.div>
          )}
          <motion.span
            className={`relative rounded-xl px-3 py-1 text-4xl font-black ring-4 ${
              plan.kind === 'draw' ? 'text-warn ring-warn/70' : 'text-danger ring-danger/70'
            }`}
            initial={{ scale: 2.6, opacity: 0, rotate: -14 }}
            animate={{ scale: 1, opacity: 1, rotate: -6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 16 }}
          >
            {plan.kind === 'draw' ? t.reveal.draw : t.reveal.stamp}
          </motion.span>
          <span className="relative whitespace-nowrap text-base font-bold text-white drop-shadow">{caption}</span>
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        {stage === 'stamp' ? caption : ''}
      </div>
      {/* The only interactive layer: tap anywhere to skip to the result. */}
      <button
        type="button"
        data-testid="reveal-skip"
        aria-label={t.reveal.skip}
        onClick={onDone}
        className="absolute inset-0 h-full w-full cursor-pointer bg-transparent"
      />
    </div>
  );
}
