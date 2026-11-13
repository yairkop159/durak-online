import { cardId, type Card, type Rank, type Suit } from '@durak/shared';
import { t } from '../../i18n';

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

export type CardSize = 'sm' | 'md' | 'lg';
/** playable = highlighted, dimmed = not playable now, selected = waiting for a target, target = can be clicked as a target. */
export type CardState = 'plain' | 'playable' | 'dimmed' | 'selected' | 'target';

const SIZE: Record<CardSize, string> = {
  sm: 'w-9 h-13 text-[10px]',
  md: 'w-12 h-[4.5rem] text-xs sm:w-14 sm:h-20 sm:text-sm',
  lg: 'w-14 h-20 text-sm sm:w-16 sm:h-24 sm:text-base',
};

const STATE: Record<CardState, string> = {
  plain: '',
  playable: 'ring-2 ring-amber-400 -translate-y-1 shadow-lg cursor-pointer',
  dimmed: 'opacity-45 saturate-50',
  selected: 'ring-4 ring-sky-500 -translate-y-3 shadow-xl cursor-pointer',
  target: 'ring-2 ring-sky-400 ring-offset-2 ring-offset-emerald-800 cursor-pointer',
};

export interface PlayingCardProps {
  readonly card: Card;
  readonly size?: CardSize;
  readonly state?: CardState;
  readonly onClick?: () => void;
}

/** A face-up card drawn with CSS: rank + suit in two corners and a large suit in the middle. */
export function PlayingCard({ card, size = 'md', state = 'plain', onClick }: PlayingCardProps) {
  const color = isRed(card.suit) ? 'text-red-600' : 'text-slate-900';
  const symbol = SUIT_SYMBOL[card.suit];
  const rank = RANK_LABEL[card.rank];
  const className = [
    'relative shrink-0 select-none rounded-md border border-slate-300 bg-white font-bold leading-none',
    'transition-transform duration-100',
    SIZE[size],
    STATE[state],
    color,
  ].join(' ');
  const face = (
    <>
      <span className="absolute top-0.5 left-1 flex flex-col items-center">
        <span>{rank}</span>
        <span>{symbol}</span>
      </span>
      <span className="absolute inset-0 flex items-center justify-center text-[1.9em]">{symbol}</span>
      <span className="absolute right-1 bottom-0.5 flex rotate-180 flex-col items-center">
        <span>{rank}</span>
        <span>{symbol}</span>
      </span>
    </>
  );
  const common = { dir: 'ltr' as const, 'data-card': cardId(card), 'data-state': state, className };
  if (!onClick) {
    return (
      <div {...common} role="img" aria-label={cardLabel(card)}>
        {face}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...common}
      aria-label={cardLabel(card)}
      aria-pressed={state === 'selected'}
      aria-disabled={state === 'dimmed'}
      onClick={onClick}
    >
      {face}
    </button>
  );
}
