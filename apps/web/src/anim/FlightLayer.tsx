import { motion } from 'motion/react';
import { useState } from 'react';
import { CardBack } from '../components/cards/CardBack';
import { PlayingCard } from '../components/cards/PlayingCard';
import { ease } from '../theme/motion';
import type { Flight } from './useBoardAnimation';

/**
 * Transient cards flying between anchors, drawn above everything and never interactive.
 * A new list (new game version) replaces the old one: in-flight cards are dropped at once.
 */
export function FlightLayer({ flights }: { flights: readonly Flight[] }) {
  const [landed, setLanded] = useState<ReadonlySet<string>>(new Set());
  const active = flights.filter((f) => !landed.has(f.key));
  if (active.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden" aria-hidden="true" data-testid="flights">
      {active.map((f) => (
        <motion.div
          key={f.key}
          className="absolute top-0 left-0"
          style={{ width: f.to.width, height: f.to.height, transformOrigin: '50% 50%' }}
          initial={{ x: f.from.x, y: f.from.y, scale: f.from.width / f.to.width, rotate: 0, opacity: 1 }}
          animate={{ x: f.to.x, y: f.to.y, scale: 1, rotate: f.rotate, opacity: f.vanish ? [1, 1, 0] : 1 }}
          transition={{
            delay: f.delayMs / 1000,
            duration: f.durationMs / 1000,
            ease,
            opacity: f.vanish ? { delay: f.delayMs / 1000, duration: f.durationMs / 1000, times: [0, 0.75, 1] } : { duration: 0 },
          }}
          onAnimationComplete={() => setLanded((s) => new Set(s).add(f.key))}
        >
          {f.face ? (
            <PlayingCard card={f.face} decorative className="h-full! w-full!" />
          ) : (
            <CardBack size="md" className="h-full! w-full! rounded-card-sm" />
          )}
        </motion.div>
      ))}
    </div>
  );
}
