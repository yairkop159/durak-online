import { cardId, type Card, type ClientMove } from '@durak/shared';
import { useState } from 'react';
import { anchorKey, useAnchorRegistry } from '../../anim/anchors';
import { revealStyle, type BoardAnimation } from '../../anim/useBoardAnimation';
import { PlayingCard, type CardState } from '../../components/cards/PlayingCard';
import { isPlayable, type Selection } from '../../game/selection';

/** Fan geometry: rotation and drop per card; flatter (and scrollable) as the hand grows. */
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
}: {
  hand: readonly Card[];
  anim: BoardAnimation;
  moves: readonly ClientMove[];
  selection: Selection;
  interactive: boolean;
  shakeHand: boolean;
  onShakeHandEnd: () => void;
  onCardClick: (card: Card) => void;
}) {
  const registry = useAnchorRegistry();
  const [shaking, setShaking] = useState<string | null>(null);
  const { rotate, drop, overlap } = fanLayout(hand.length);
  return (
    <div className="w-full overflow-x-auto overflow-y-visible [scrollbar-width:thin]">
      <ul
        className={`mx-auto flex w-max min-w-full justify-center px-6 pt-7 pb-8 ${shakeHand ? 'animate-shake' : ''}`}
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
