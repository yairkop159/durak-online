import { cardId, type BoutSummary, type ClientMove, type PlayerView, type TablePair } from '@durak/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { anchorKey, useAnchorRegistry } from '../../anim/anchors';
import { revealStyle, type BoardAnimation } from '../../anim/useBoardAnimation';
import { CardBack } from '../../components/cards/CardBack';
import { PlayingCard, SUIT_SYMBOL, isRed, type CardState } from '../../components/cards/PlayingCard';
import { isAttackTarget, type Selection } from '../../game/selection';
import { t } from '../../i18n';
import { motionTokens as M } from '../../theme/motion';

/** The stock with visible depth, the trump rotated 90° under it, and a count chip. */
export function DeckPile({ view }: { view: PlayerView }) {
  const registry = useAnchorRegistry();
  const layers = view.deckCount <= 1 ? 0 : Math.min(3, Math.ceil(view.deckCount / 8));
  return (
    <div className="flex w-[84px] shrink-0 flex-col items-center gap-1 sm:w-24" data-testid="deck">
      <div className="relative h-[72px] w-[84px] sm:h-20 sm:w-24">
        {/* The face-up trump lies under the stock; it stays visible (and known) after the stock runs out. */}
        <div
          ref={registry.ref(anchorKey.trump)}
          className={`absolute top-[6px] left-[34px] rotate-90 sm:top-[9px] sm:left-[44px] ${view.deckCount === 0 ? 'opacity-45 grayscale-[.4]' : ''}`}
        >
          <PlayingCard card={view.trumpCard} size="sm" />
        </div>
        {layers > 0 && (
          <div ref={registry.ref(anchorKey.deck)} className="absolute top-1 left-0">
            {Array.from({ length: layers }, (_, i) => (
              <CardBack
                key={i}
                size="sm"
                className="absolute"
                style={{ top: -i * 2, left: -i * 2, boxShadow: i === layers - 1 ? undefined : 'none' }}
              />
            ))}
            <CardBack size="sm" className="invisible" />
          </div>
        )}
        {view.deckCount > 0 && (
          <span className="absolute -top-1 -right-1 z-10 min-w-6 rounded-pill bg-surface-3 px-1.5 text-center text-[11px] font-bold tabular-nums ring-1 ring-line-strong">
            {view.deckCount}
          </span>
        )}
      </div>
      <span className="text-[11px] text-muted">{view.deckCount > 0 ? t.table.deck(view.deckCount) : t.table.deckEmpty}</span>
      <span className="text-[11px] text-muted">
        {t.table.trump}:{' '}
        <span className={`text-sm ${isRed(view.trumpSuit) ? 'text-card-red brightness-150' : 'text-text'}`}>{SUIT_SYMBOL[view.trumpSuit]}</span>
      </span>
    </div>
  );
}

/** The discard pile (a flight target even while empty) plus a faint peek at the last bout. */
export function DiscardPile({ view, showLastBout }: { view: PlayerView; showLastBout: boolean }) {
  const registry = useAnchorRegistry();
  const shown = Math.min(3, Math.ceil(view.discardCount / 6));
  return (
    <div className="flex w-16 shrink-0 flex-col items-center gap-1 sm:w-20" aria-label={t.table.discardPile}>
      <div ref={registry.ref(anchorKey.discard)} className="relative h-[62px] w-11">
        {shown === 0 ? (
          <div className="h-full w-full rounded-card-sm border border-dashed border-line-strong" />
        ) : (
          Array.from({ length: shown }, (_, i) => (
            <CardBack key={i} size="sm" className="absolute inset-0" style={{ rotate: `${[-8, 6, -2][i]}deg` }} />
          ))
        )}
      </div>
      <span className="text-[11px] text-muted">{t.table.discard(view.discardCount)}</span>
      <AnimatePresence>
        {showLastBout && view.lastBout && <LastBoutPeek key={view.boutNumber} bout={view.lastBout} />}
      </AnimatePresence>
    </div>
  );
}

function LastBoutPeek({ bout }: { bout: BoutSummary }) {
  return (
    <motion.div
      data-testid="last-bout"
      aria-label={t.table.lastBout}
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.45 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="flex max-w-20 flex-wrap justify-center gap-0.5"
      dir="ltr"
    >
      {bout.table.map((p, i) => (
        <span key={i} className="relative h-12 w-7">
          <PlayingCard card={p.attack} size="xs" decorative className="absolute" />
          {p.defense && <PlayingCard card={p.defense} size="xs" decorative className="absolute top-2 left-1.5 rotate-[15deg]" />}
        </span>
      ))}
    </motion.div>
  );
}

/** At most this many pairs share a row on the table. */
export const PAIRS_PER_ROW = 3;
/** A pair's box (attack card + the defense card laid over it), in card widths / heights. */
const PAIR_W = 1.25;
const PAIR_H = 1.28;
/** Gaps between pairs, in card widths (columns) / heights (rows). */
const GAP_X = 0.3;
const GAP_Y = 0.12;
const CARD_ASPECT = 78 / 54;
const MIN_CARD_W = 28;

/** The table card's natural width (the `--card-table-w(-lg)` tokens) at this viewport width. */
export function naturalTableCardWidth(viewportW: number): number {
  return viewportW >= 640 ? Math.min(90, Math.max(64, 0.042 * viewportW + 30)) : 54;
}

/**
 * The table card width that fits `items` (pairs + the transfer slot) into a `boxW` × `boxH` area,
 * at most PAIRS_PER_ROW per row, never larger than `maxW`: the table never grows, its cards shrink.
 */
export function fitTableCardWidth(items: number, boxW: number, boxH: number, maxW: number): number {
  const cols = Math.max(1, Math.min(items, PAIRS_PER_ROW));
  const rows = Math.max(1, Math.ceil(items / PAIRS_PER_ROW));
  const byW = boxW / (cols * PAIR_W + (cols - 1) * GAP_X);
  const byH = boxH / ((rows * PAIR_H + (rows - 1) * GAP_Y) * CARD_ASPECT);
  return Math.max(MIN_CARD_W, Math.floor(Math.min(maxW, byW, byH)));
}

/** Tracks an element's content-box size. */
function useBoxSize<E extends HTMLElement>(): [(el: E | null) => void, { w: number; h: number } | null] {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: E | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  return [ref, size];
}

export function TableArea({
  table,
  anim,
  moves,
  selection,
  interactive,
  transferMove,
  onAttackClick,
  onTransferClick,
}: {
  table: readonly TablePair[];
  anim: BoardAnimation;
  moves: readonly ClientMove[];
  selection: Selection;
  interactive: boolean;
  transferMove: ClientMove | null;
  onAttackClick: (index: number) => void;
  onTransferClick: () => void;
}) {
  const registry = useAnchorRegistry();
  const [boxRef, box] = useBoxSize<HTMLDivElement>();
  const showTransfer = interactive && transferMove !== null;
  const items = table.length + (showTransfer ? 1 : 0);
  // The cards shrink to fit the space the screen leaves for the table (the table never grows).
  const cardW = box ? fitTableCardWidth(items, box.w, box.h, naturalTableCardWidth(window.innerWidth)) : null;
  const sizing: CSSProperties | undefined =
    cardW === null
      ? undefined
      : ({
          '--card-table-w': `${cardW}px`,
          '--card-table-h': `${Math.round(cardW * CARD_ASPECT)}px`,
          '--card-table-w-lg': `${cardW}px`,
          '--card-table-h-lg': `${Math.round(cardW * CARD_ASPECT)}px`,
          gridTemplateColumns: `repeat(${Math.min(items, PAIRS_PER_ROW)}, auto)`,
          columnGap: Math.round(cardW * GAP_X),
          rowGap: Math.round(cardW * CARD_ASPECT * GAP_Y),
        } as CSSProperties);
  return (
    <div ref={boxRef} className="relative min-h-24 min-w-0 flex-1 self-stretch">
      {table.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted/70">{t.table.emptyTable}</div>
      ) : (
        <ul
          className="absolute inset-0 grid content-center items-center justify-center"
          style={sizing ?? { gridTemplateColumns: `repeat(${Math.min(items, PAIRS_PER_ROW)}, auto)`, gap: 12 }}
          data-testid="table"
          data-card-width={cardW ?? undefined}
          dir="ltr"
        >
          {table.map((pair, index) => {
            const target = interactive && pair.defense === null && isAttackTarget(index, moves, selection);
            const selected = selection.kind === 'attack' && selection.index === index;
            const state: CardState = selected ? 'selected' : target ? 'target' : 'plain';
            const attackId = cardId(pair.attack);
            return (
              <li
                key={attackId}
                className="relative h-[calc(var(--card-table-h)*1.28)] w-[calc(var(--card-table-w)*1.25)] sm:h-[calc(var(--card-table-h-lg)*1.28)] sm:w-[calc(var(--card-table-w-lg)*1.25)]"
                data-testid={`pair-${index}`}
              >
                <PlayingCard
                  card={pair.attack}
                  layoutId={attackId}
                  state={state}
                  ref={registry.ref(anchorKey.card(attackId))}
                  style={revealStyle(anim, pair.attack)}
                  {...(target || selected ? { onClick: () => onAttackClick(index) } : {})}
                />
                {pair.defense && (
                  <div
                    className="absolute top-[calc(var(--card-table-h)*0.22)] left-[calc(var(--card-table-w)*0.22)] sm:top-[calc(var(--card-table-h-lg)*0.22)] sm:left-[calc(var(--card-table-w-lg)*0.22)]"
                    style={{ rotate: `${M.defenseRotateDeg}deg` }}
                  >
                    <PlayingCard
                      card={pair.defense}
                      layoutId={cardId(pair.defense)}
                      ref={registry.ref(anchorKey.card(cardId(pair.defense)))}
                      style={revealStyle(anim, pair.defense)}
                    />
                  </div>
                )}
              </li>
            );
          })}
          {showTransfer && (
            <li>
              <motion.button
                type="button"
                onClick={onTransferClick}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex h-(--card-table-h) w-(--card-table-w) items-center justify-center rounded-card border-2 border-dashed border-select text-xs font-bold text-select shadow-target sm:h-(--card-table-h-lg) sm:w-(--card-table-w-lg)"
              >
                {t.table.transferHere}
              </motion.button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
