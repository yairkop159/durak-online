import type { CardSize } from './PlayingCard';

const SIZE: Record<CardSize, string> = {
  sm: 'w-6 h-9 sm:w-7 sm:h-10',
  md: 'w-12 h-[4.5rem] sm:w-14 sm:h-20',
  lg: 'w-14 h-20 sm:w-16 sm:h-24',
};

/** A face-down card: a patterned back drawn with CSS gradients. */
export function CardBack({ size = 'sm', className = '' }: { size?: CardSize; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`shrink-0 rounded-sm border border-white/70 shadow ${SIZE[size]} ${className}`}
      style={{
        backgroundColor: '#1e3a8a',
        backgroundImage:
          'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 6px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 6px)',
      }}
    />
  );
}

/** A small fanned stack of card backs plus the exact count (stack capped so 20 cards stay compact). */
export function CardBackStack({ count, max = 6 }: { count: number; max?: number }) {
  const shown = Math.min(count, max);
  return (
    <div className="flex items-center gap-1" dir="ltr">
      <div className="flex">
        {Array.from({ length: shown }, (_, i) => (
          <CardBack key={i} size="sm" className={i === 0 ? '' : '-ms-4'} />
        ))}
      </div>
    </div>
  );
}
