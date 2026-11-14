import { cardId, type Card, type ClientMove } from '@durak/shared';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { anchorKey, useAnchorRegistry } from '../../anim/anchors';
import { revealStyle, type BoardAnimation } from '../../anim/useBoardAnimation';
import { PlayingCard, type CardState } from '../../components/cards/PlayingCard';
import { isPlayable, type Selection } from '../../game/selection';

/** Fan geometry: rotation and drop per card; flatter as the hand grows. */
export function fanLayout(count: number): { rotate: number[]; drop: number[]; overlap: number } {
  const mid = (count - 1) / 2;
  const spread = count <= 1 ? 0 : count > 10 ? 0 : Math.min(5, 26 / (count - 1));
  const curve = count > 10 ? 0 : 1.5;
  const overlap = count <= 6 ? 16 : count <= 10 ? 24 : 30;
  return {
    rotate: Array.from({ length: count }, (_, i) => (i - mid) * spread),
    drop: Array.from({ length: count }, (_, i) => (i - mid) ** 2 * curve),
    overlap,
  };
}

/** On a short landscape screen the hand row is the main thing: up to 27% of the height. */
const SHORT_HAND = {
  '--card-hand-h-lg': 'min(96px, 27dvh)',
  '--card-hand-w-lg': 'calc(min(96px, 27dvh) * 0.7)',
} as CSSProperties;

/** The narrowest slice of a covered card that stays visible (its index and a click target). */
export const MIN_VISIBLE_SLICE = 16;

/**
 * The overlap that fits `count` cards of width `cardW` into `availW`: never less than the fan's
 * own overlap, more when the hand is too wide (the hand compresses instead of growing).
 */
export function fitOverlap(count: number, cardW: number, availW: number, base: number): number {
  if (count <= 1 || cardW <= 0 || availW <= 0) return base;
  const needed = Math.ceil((count * cardW - availW) / (count - 1));
  return Math.max(base, Math.min(needed, cardW - MIN_VISIBLE_SLICE));
}

/** The width the hand may use and the width of one card, kept up to date. */
function useHandRoom(count: number): [(el: HTMLElement | null) => void, { avail: number; cardW: number } | null] {
  const [room, setRoom] = useState<{ avail: number; cardW: number } | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const remeasure = useRef<() => void>(() => {});
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    remeasure.current = () => {};
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const avail = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // The card size is a CSS token that changes with the breakpoint: measure a card.
      const cardW = el.querySelector<HTMLElement>('[data-card]')?.offsetWidth ?? 0;
      setRoom((prev) => (prev && prev.avail === avail && prev.cardW === cardW ? prev : { avail, cardW }));
    };
    remeasure.current = measure;
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  // A first card to measure may appear later (the width itself is watched by the observer).
  useLayoutEffect(() => remeasure.current(), [count > 0]);
  return [ref, room];
}

/**
 * The viewer's hand as a fanned arc. Left-to-right with each card overlapping the previous one's
 * right side, so every top-left index stays visible (dir="ltr": RTL never mirrors the cards).
 */
export function HandFan({
  hand,
  anim,
  moves,
  selection,
  interactive,
  shakeHand,
  onShakeHandEnd,
  onCardClick,
  short = false,
}: {
  hand: readonly Card[];
  anim: BoardAnimation;
  moves: readonly ClientMove[];
  selection: Selection;
  interactive: boolean;
  shakeHand: boolean;
  onShakeHandEnd: () => void;
  onCardClick: (card: Card) => void;
  /** A short landscape screen: the hand is beside the side panel and may be taller than 15dvh. */
  short?: boolean;
}) {
  const registry = useAnchorRegistry();
  const [shaking, setShaking] = useState<string | null>(null);
  const [roomRef, room] = useHandRoom(hand.length);
  const fan = fanLayout(hand.length);
  const { rotate, drop } = fan;
  // Never wider than the screen: a big hand overlaps more instead of scrolling.
  const overlap = room ? fitOverlap(hand.length, room.cardW, room.avail, fan.overlap) : fan.overlap;
  // Room below for the fan's lowest corner (drop + rotation), no more.
  const maxDrop = drop.length > 0 ? Math.max(...drop) : 0;
  const maxTilt = rotate.length > 0 ? Math.max(...rotate.map(Math.abs)) : 0;
  const padBottom = Math.ceil(maxDrop + maxTilt * 0.6 + 6);
  return (
    <div className="w-full" style={short ? SHORT_HAND : undefined}>
      <ul
        ref={roomRef}
        className={`mx-auto flex w-full justify-center px-2 pt-5 ${shakeHand ? 'animate-shake' : ''}`}
        style={{ paddingBottom: padBottom }}
        dir="ltr"
        data-testid="hand"
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) onShakeHandEnd();
        }}
      >
        {hand.map((card, i) => {
          const id = cardId(card);
          const selected = selection.kind === 'hand' && selection.card.suit === card.suit && selection.card.rank === card.rank;
          const playable = interactive && isPlayable(card, moves, selection);
          const state: CardState = !interactive ? 'plain' : selected ? 'selected' : playable ? 'playable' : 'dimmed';
          return (
            <li
              key={id}
              className="relative origin-bottom transition-[rotate,translate] duration-300"
              style={{
                marginInlineStart: i === 0 ? 0 : -overlap,
                rotate: `${rotate[i]}deg`,
                translate: `0 ${drop[i]}px`,
                zIndex: selected ? 50 : i,
              }}
            >
              <PlayingCard
                card={card}
                size="lg"
                state={state}
                layoutId={id}
                ref={registry.ref(anchorKey.card(id))}
                style={revealStyle(anim, card)}
                shake={shaking === id}
                onShakeEnd={() => setShaking(null)}
                onClick={() => {
                  if (state === 'dimmed') setShaking(id);
                  onCardClick(card);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
