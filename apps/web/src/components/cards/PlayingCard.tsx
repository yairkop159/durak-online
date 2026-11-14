import { cardId, type Card, type Rank, type Suit } from '@durak/shared';
import { motion, type MotionStyle } from 'motion/react';
import type { CSSProperties, Ref } from 'react';
import { t } from '../../i18n';
import { motionTokens as M } from '../../theme/motion';

const RANK_LABEL: Record<Rank, string> = {
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

// U+FE0E keeps the text presentation (some platforms render ♥/♦ as emoji otherwise).
export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠︎', C: '♣︎', D: '♦︎', H: '♥︎' };

export function isRed(suit: Suit): boolean {
  return suit === 'D' || suit === 'H';
}

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]} ${t.suits[card.suit]}`;
}

/** xs = last-bout peek, sm = trump under the deck, md = table, lg = hand. */
export type CardSize = 'xs' | 'sm' | 'md' | 'lg';
/** playable = highlighted, dimmed = not playable now, selected = waiting for a target, target = can be clicked as a target. */
export type CardState = 'plain' | 'playable' | 'dimmed' | 'selected' | 'target';

export const CARD_SIZE: Record<CardSize, string> = {
  xs: 'w-7 h-10 text-[9px] rounded-card-sm',
  sm: 'w-11 h-[62px] text-[11px] rounded-card-sm',
  // The font follows the width: the table shrinks its cards (and their indices) to fit.
  md: 'w-(--card-table-w) h-(--card-table-h) text-[calc(var(--card-table-w)*0.24)] sm:w-(--card-table-w-lg) sm:h-(--card-table-h-lg) sm:text-[calc(var(--card-table-w-lg)*0.235)] rounded-card',
  lg: 'w-(--card-hand-w) h-(--card-hand-h) text-[15px] sm:w-(--card-hand-w-lg) sm:h-(--card-hand-h-lg) sm:text-[clamp(17px,0.45vw+12px,19px)] rounded-card',
};

const STATE: Record<CardState, string> = {
  plain: 'shadow-card',
  // Legal: lifts and glows on hover (CSS `translate` composes with Framer's `transform`).
  playable:
    'shadow-card cursor-pointer hover:-translate-y-2.5 hover:shadow-lift focus-visible:-translate-y-2.5 focus-visible:shadow-lift [--lift:0px] hover:[--lift:-10px]',
  // Not legal right now: only slightly dimmed, still readable.
  dimmed: 'shadow-card opacity-85 saturate-[.75] brightness-[.96]',
  selected: 'shadow-selected -translate-y-[18px] cursor-pointer [--lift:-18px]',
  target: 'shadow-target cursor-pointer',
};

export interface PlayingCardProps {
  readonly card: Card;
  readonly size?: CardSize;
  readonly state?: CardState;
  readonly onClick?: () => void;
  /** Shared-element id (the card id) so a card moving hand <-> table animates. */
  readonly layoutId?: string | undefined;
  readonly shake?: boolean;
  readonly onShakeEnd?: () => void;
  readonly className?: string;
  readonly style?: CSSProperties | undefined;
  readonly ref?: Ref<HTMLElement>;
  /** A transient copy (flight): rendered without data-card, role or label. */
  readonly decorative?: boolean;
}

/** A face-up card drawn with CSS: indices in two corners (never mirrored in RTL) and a large suit. */
export function PlayingCard({
  card,
  size = 'md',
  state = 'plain',
  onClick,
  layoutId,
  shake = false,
  onShakeEnd,
  className = '',
  style,
  ref,
  decorative = false,
}: PlayingCardProps) {
  const red = isRed(card.suit);
  const symbol = SUIT_SYMBOL[card.suit];
  const rank = RANK_LABEL[card.rank];
  const classes = [
    'relative block shrink-0 select-none overflow-hidden border border-card-edge bg-card font-extrabold leading-none outline-none',
    'transition-[translate,box-shadow,opacity,filter] duration-(--dur-hover) ease-out',
    red ? 'text-card-red' : 'text-card-ink',
    CARD_SIZE[size],
    STATE[state],
    shake ? 'animate-shake' : '',
    className,
  ].join(' ');
  const face = (
    <>
      <span className="absolute top-[0.3em] left-[0.32em] flex flex-col items-center gap-[0.12em]">
        <span className="tracking-tighter">{rank}</span>
        <span className="text-[0.85em]">{symbol}</span>
      </span>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-[2.1em] opacity-90">
        {symbol}
      </span>
      <span className="absolute right-[0.32em] bottom-[0.3em] flex rotate-180 flex-col items-center gap-[0.12em]">
        <span className="tracking-tighter">{rank}</span>
        <span className="text-[0.85em]">{symbol}</span>
      </span>
    </>
  );
  const common = {
    dir: 'ltr' as const,
    'data-card': cardId(card),
    'data-state': state,
    className: classes,
    // Plain CSS only (no motion values), so React's CSSProperties is a valid MotionStyle.
    ...(style ? { style: style as MotionStyle } : {}),
    ...(layoutId ? { layoutId } : {}),
    // Played / taken cards glide on a spring; reduced motion is handled by <MotionConfig>.
    transition: { layout: M.playSpring },
    ...(shake && onShakeEnd ? { onAnimationEnd: onShakeEnd } : {}),
  };
  if (decorative) {
    // Flight copies: no identity in the DOM, invisible to assistive tech.
    return (
      <div dir="ltr" aria-hidden="true" className={classes} style={style}>
        {face}
      </div>
    );
  }
  if (!onClick) {
    return (
      <motion.div {...common} ref={ref as Ref<HTMLDivElement>} role="img" aria-label={cardLabel(card)}>
        {face}
      </motion.div>
    );
  }
  return (
    <motion.button
      type="button"
      {...common}
      ref={ref as Ref<HTMLButtonElement>}
      aria-label={cardLabel(card)}
      aria-pressed={state === 'selected'}
      aria-disabled={state === 'dimmed'}
      onClick={onClick}
    >
      {face}
    </motion.button>
  );
}
