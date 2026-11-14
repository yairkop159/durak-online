import { motion, useReducedMotion } from 'motion/react';
import { t } from '../i18n';
import type { ClientReaction } from '../net/store';
import { REACTION_SHOW_MS } from '../net/store';
import { useSettings } from '../settings/react';
import { ANIMATION_SPEED_FACTOR } from '../settings/settings';

/**
 * A reaction bubble floating above a seat (key it by `reaction.id` so each one re-animates). Purely visual: it never takes clicks
 * (pointer-events: none), so it can't block a card or a button under it. Screen readers get the
 * reaction from the polite live region (ReactionAnnouncer), not from here.
 */
export function ReactionBubble({ reaction, className = '' }: { reaction: ClientReaction; className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const speed = ANIMATION_SPEED_FACTOR[useSettings().animationSpeed];
  const item = t.reactions.items[reaction.reactionId];
  const emoji = item.text !== item.label;
  const seconds = (REACTION_SHOW_MS * speed) / 1000;
  return (
    <motion.span
      data-testid={`reaction-bubble-${reaction.playerId}`}
      aria-hidden="true"
      className={`pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 whitespace-nowrap rounded-2xl bg-surface-2 px-2 py-0.5 font-bold shadow-lg ring-1 ring-accent/40 ${
        emoji ? 'text-2xl leading-none' : 'text-xs'
      } ${className}`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 8 }}
      animate={
        reduced
          ? { opacity: [0, 1, 1, 0] }
          : { opacity: [0, 1, 1, 0], scale: [0.4, 1.12, 1, 1], y: [8, 0, -6, -14] }
      }
      transition={{ duration: reduced ? Math.min(seconds, 2) : seconds, times: [0, 0.12, 0.8, 1], ease: 'easeOut' }}
      style={{ transformOrigin: 'bottom center', translateX: '-50%' }}
    >
      {item.text}
    </motion.span>
  );
}

/** Reads the newest reaction aloud (polite), once per reaction. */
export function ReactionAnnouncer({ latest, nameOf }: { latest: ClientReaction | null; nameOf: (id: string) => string }) {
  return (
    <div aria-live="polite" className="sr-only" data-testid="reaction-announcer">
      {latest ? t.reactions.announce(nameOf(latest.playerId), t.reactions.items[latest.reactionId].label) : ''}
    </div>
  );
}
