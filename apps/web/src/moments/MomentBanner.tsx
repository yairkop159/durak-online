import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import type { SeatEffect as SeatEffectKind } from '../anim/moments';
import { SUIT_SYMBOL } from '../components/cards/PlayingCard';
import { t } from '../i18n';
import { motionTokens as M } from '../theme/motion';
import { momentText } from './momentText';
import type { ActiveMoment } from './useMomentQueue';

/**
 * The moment banner over the table. Purely visual (pointer-events: none): it never blocks a card
 * or a button. The text is also in a polite live region for screen readers.
 */
export function MomentBanner({
  active,
  viewerId,
  nameOf,
  reduced,
}: {
  active: ActiveMoment | null;
  viewerId: string | null;
  nameOf: (id: string) => string;
  reduced: boolean;
}) {
  const text = active ? momentText(active.moment, viewerId, nameOf, t) : '';
  return (
    <>
      <div aria-live="polite" className="sr-only" data-testid="moment-announcer">
        {text}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-[38%] z-30 flex justify-center px-4" aria-hidden="true">
        <AnimatePresence>
          {active && (
            <motion.div
              key={active.id}
              data-testid="moment-banner"
              data-moment={active.moment.type}
              className="pointer-events-none rounded-2xl bg-bg-0/85 px-4 py-2 text-center text-lg font-black text-accent shadow-xl ring-1 ring-accent/40 backdrop-blur-sm sm:text-xl"
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -10 }}
              transition={reduced ? { duration: M.reducedFadeMs / 1000 } : { type: 'spring', stiffness: 420, damping: 24 }}
            >
              {text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

const BURST = Object.values(SUIT_SYMBOL);

/**
 * A short effect on a seat's avatar for the moment on screen: confetti burst (went out), shake
 * (big take), shine (perfect defense / got the trump), pulse (transfer target). Decorative and
 * pointer-events: none. Reduced motion: a static glow ring only.
 */
export function SeatEffect({ effect, momentId, reduced }: { effect: SeatEffectKind; momentId: number; reduced: boolean }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return { x: Math.cos(a) * 34, y: Math.sin(a) * 34 - 6, glyph: BURST[i % BURST.length]!, delay: (i % 3) * 0.04 };
      }),
    [],
  );
  const ring = effect === 'shake' ? 'ring-warn/80' : 'ring-accent';
  return (
    <span
      key={momentId}
      data-testid="seat-effect"
      data-effect={effect}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      {reduced ? (
        <span className={`absolute -inset-1 rounded-full ring-2 ${ring}`} />
      ) : (
        <>
          <motion.span
            className={`absolute -inset-1 rounded-full ring-2 ${ring}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={
              effect === 'shake'
                ? { opacity: [0, 1, 1, 0], x: [...M.shakeX], scale: 1 }
                : effect === 'pulse'
                  ? { opacity: [0, 1, 0.4, 1, 0], scale: [0.8, 1.15, 1, 1.15, 1] }
                  : { opacity: [0, 1, 1, 0], scale: [0.8, 1.2, 1.1, 1.3] }
            }
            transition={{ duration: 1.2, ease: 'easeOut' }}
          />
          {effect === 'celebrate' &&
            pieces.map((p, i) => (
              <motion.span
                key={i}
                className="absolute text-xs font-black text-accent"
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.5 }}
                animate={{ x: p.x, y: p.y, opacity: [0, 1, 0], scale: 1 }}
                transition={{ duration: 0.9, delay: p.delay, ease: 'easeOut' }}
              >
                {p.glyph}
              </motion.span>
            ))}
        </>
      )}
    </span>
  );
}
