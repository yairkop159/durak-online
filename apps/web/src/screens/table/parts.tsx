import type { Card, ClientMove, PlayerView, PublicPlayer, RoomMember, TablePair } from '@durak/shared';
import { CardBack, CardBackStack } from '../../components/cards/CardBack';
import { PlayingCard, SUIT_SYMBOL, isRed, type CardState } from '../../components/cards/PlayingCard';
import { Badge, Button } from '../../components/ui';
import { isAttackTarget, isPlayable, type Selection } from '../../game/selection';
import { t } from '../../i18n';
import { secondsLeft } from '../../net/clock';

/** Role/status badges shared by opponents and the viewer's own row. */
export function PlayerBadges({ player, view, member }: { player: PublicPlayer; view: PlayerView; member?: RoomMember | undefined }) {
  const phase = view.phase;
  const playing = phase.kind !== 'finished';
  return (
    <span className="flex flex-wrap items-center justify-center gap-1">
      {playing && !player.finished && view.attackerId === player.id && <Badge tone="red">{t.table.attacker}</Badge>}
      {playing && !player.finished && view.defenderId === player.id && <Badge tone="blue">{t.table.defender}</Badge>}
      {phase.kind === 'bout' && phase.passed.includes(player.id) && <Badge>{t.table.passed}</Badge>}
      {player.finished && <Badge tone="amber">{t.table.out}</Badge>}
      {member && !member.connected && <Badge tone="gray">{t.table.offline}</Badge>}
      {member?.afk && <Badge tone="red">{t.table.afk}</Badge>}
    </span>
  );
}

export function OpponentSeat({
  player,
  name,
  view,
  member,
}: {
  player: PublicPlayer;
  name: string;
  view: PlayerView;
  member: RoomMember | undefined;
}) {
  const active = view.phase.kind !== 'finished' && (view.attackerId === player.id || view.defenderId === player.id);
  return (
    <li
      data-testid={`seat-${player.id}`}
      dir="rtl"
      className={`flex min-w-24 flex-col items-center gap-1 rounded-xl px-2 py-1.5 ${active ? 'bg-white/15' : 'bg-white/5'} ${player.finished ? 'opacity-60' : ''}`}
    >
      <span className="max-w-28 truncate text-sm font-semibold">{name}</span>
      <div className="flex items-center gap-1.5">
        <CardBackStack count={player.handCount} />
        <span className="text-xs text-emerald-100/80" aria-label={t.table.cards(player.handCount)}>
          {player.handCount}
        </span>
      </div>
      <PlayerBadges player={player} view={view} member={member} />
    </li>
  );
}

export function DeckArea({ view }: { view: PlayerView }) {
  const trump = view.trumpCard;
  return (
    <div className="flex flex-col items-center gap-1 text-xs text-emerald-100/90" data-testid="deck">
      <div className="relative h-24 w-20">
        {/* The face-up trump lies under the stock, rotated; it stays visible (and known) after the stock runs out. */}
        <div className={`absolute top-3 left-5 rotate-90 ${view.deckCount === 0 ? 'opacity-50' : ''}`}>
          <PlayingCard card={trump} size="sm" />
        </div>
        {view.deckCount > 1 && (
          <div className="absolute top-1 left-0">
            <CardBack size="md" />
          </div>
        )}
      </div>
      <span>{t.table.deck(view.deckCount)}</span>
      <span>
        {t.table.trump}: <span className={`text-base ${isRed(view.trumpSuit) ? 'text-red-300' : 'text-white'}`}>{SUIT_SYMBOL[view.trumpSuit]}</span>
      </span>
      <span>{t.table.discard(view.discardCount)}</span>
    </div>
  );
}

export function TableArea({
  table,
  moves,
  selection,
  interactive,
  transferMove,
  onAttackClick,
  onTransferClick,
}: {
  table: readonly TablePair[];
  moves: readonly ClientMove[];
  selection: Selection;
  interactive: boolean;
  transferMove: ClientMove | null;
  onAttackClick: (index: number) => void;
  onTransferClick: () => void;
}) {
  if (table.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-sm text-emerald-100/60">{t.table.emptyTable}</div>;
  }
  return (
    <ul className="flex flex-1 flex-wrap content-center items-center justify-center gap-3" data-testid="table" dir="ltr">
      {table.map((pair, index) => {
        const target = interactive && pair.defense === null && isAttackTarget(index, moves, selection);
        const selected = selection.kind === 'attack' && selection.index === index;
        const state: CardState = selected ? 'selected' : target ? 'target' : 'plain';
        return (
          <li key={index} className="relative h-28 w-16 sm:h-32 sm:w-20" data-testid={`pair-${index}`}>
            <PlayingCard card={pair.attack} state={state} {...(target || selected ? { onClick: () => onAttackClick(index) } : {})} />
            {pair.defense && (
              <div className="absolute top-6 left-3 sm:top-8 sm:left-4">
                <PlayingCard card={pair.defense} />
              </div>
            )}
          </li>
        );
      })}
      {interactive && transferMove && (
        <li>
          <button
            type="button"
            onClick={onTransferClick}
            className="flex h-[4.5rem] w-12 items-center justify-center rounded-md border-2 border-dashed border-sky-300 text-xs font-bold text-sky-100 sm:h-20 sm:w-14"
          >
            {t.table.transferHere}
          </button>
        </li>
      )}
    </ul>
  );
}

export function MyHand({
  hand,
  moves,
  selection,
  interactive,
  onCardClick,
}: {
  hand: readonly Card[];
  moves: readonly ClientMove[];
  selection: Selection;
  interactive: boolean;
  onCardClick: (card: Card) => void;
}) {
  return (
    <ul className="flex justify-center overflow-x-auto px-2 pt-4 pb-2" dir="ltr" data-testid="hand">
      {hand.map((card, i) => {
        const selected = selection.kind === 'hand' && selection.card.suit === card.suit && selection.card.rank === card.rank;
        const playable = interactive && isPlayable(card, moves, selection);
        const state: CardState = !interactive ? 'plain' : selected ? 'selected' : playable ? 'playable' : 'dimmed';
        return (
          <li key={`${card.suit}${card.rank}`} className={i === 0 ? '' : '-ms-5 sm:-ms-4'}>
            <PlayingCard card={card} size="lg" state={state} onClick={() => onCardClick(card)} />
          </li>
        );
      })}
    </ul>
  );
}

export function ActionBar({ moves, onMove }: { moves: readonly ClientMove[]; onMove: (move: ClientMove) => void }) {
  const take = moves.find((m) => m.type === 'take');
  const pass = moves.find((m) => m.type === 'pass');
  if (!take && !pass) return null;
  return (
    <div className="flex justify-center gap-3">
      {take && (
        <Button variant="danger" onClick={() => onMove(take)}>
          {t.table.take}
        </Button>
      )}
      {pass && <Button onClick={() => onMove(pass)}>{t.table.pass}</Button>}
    </div>
  );
}

export function Countdown({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const seconds = secondsLeft(ms);
  return (
    <span
      data-testid="countdown"
      className={`min-w-14 rounded-full px-2 py-0.5 text-center text-sm font-bold tabular-nums ${seconds <= 5 ? 'bg-rose-600' : 'bg-black/30'}`}
    >
      {t.table.secondsLeft(seconds)}
    </span>
  );
}
