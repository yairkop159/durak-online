import type { CSSProperties, Ref } from 'react';
import { CARD_SIZE, type CardSize } from './PlayingCard';

export type BackSize = CardSize | 'seat';

const SIZE: Record<BackSize, string> = {
  ...CARD_SIZE,
  seat: 'w-(--card-seat-w) h-(--card-seat-h) rounded-[4px]',
};

/**
 * A face-down card. Backs are generic: they carry no card identity (no id, no layoutId, no
 * data attributes), so nothing about a hidden card can leak through the DOM.
 */
export function CardBack({
  size = 'seat',
  className = '',
  style,
  ref,
}: {
  size?: BackSize;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}) {
  return <div ref={ref} aria-hidden="true" style={style} className={`card-back shrink-0 ${SIZE[size]} ${className}`} />;
}

/** A small fan of backs for an opponent's hand (capped, so 20 cards stay compact). */
export function CardBackFan({ count, max = 5 }: { count: number; max?: number }) {
  const shown = Math.min(count, max);
  const mid = (shown - 1) / 2;
  return (
    <div className="flex h-9 items-end justify-center" dir="ltr" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <CardBack
          key={i}
          size="seat"
          className={i === 0 ? '' : '-ms-3'}
          style={{ rotate: `${(i - mid) * 9}deg`, translate: `0 ${Math.abs(i - mid) * 2}px`, transformOrigin: '50% 120%' }}
        />
      ))}
    </div>
  );
}
