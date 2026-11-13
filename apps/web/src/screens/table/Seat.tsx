import type { PlayerView, PublicPlayer, RoomMember } from '@durak/shared';
import { anchorKey, useAnchor } from '../../anim/anchors';
import { CardBackFan } from '../../components/cards/CardBack';
import { Avatar } from '../../components/ui';
import { t } from '../../i18n';
import { PlayerBadges } from './parts';

export interface TurnRing {
  /** 1 -> 0 as the turn timer runs out, or null when this player isn't awaited. */
  readonly progress: number | null;
  readonly urgent: boolean;
}

/** An opponent: avatar (+ countdown ring), name, a fan of card backs with the count, role pills. */
export function OpponentSeat({
  player,
  name,
  view,
  member,
  ring,
}: {
  player: PublicPlayer;
  name: string;
  view: PlayerView;
  member: RoomMember | undefined;
  ring: TurnRing;
}) {
  const anchor = useAnchor(anchorKey.seat(player.id));
  const awaited = ring.progress !== null;
  return (
    <li
      data-testid={`seat-${player.id}`}
      dir="rtl"
      className={`flex w-[5.75rem] flex-col items-center gap-0.5 rounded-2xl px-1.5 pt-1.5 pb-2 transition-colors sm:w-28 ${
        awaited ? 'bg-surface-2/90 ring-1 ring-accent/25' : 'bg-surface/60 ring-1 ring-line'
      } ${player.finished ? 'opacity-55' : ''}`}
    >
      <div ref={anchor} className="relative">
        <Avatar
          id={player.id}
          name={member?.isBot ? '🤖' : name}
          size={36}
          progress={ring.progress}
          urgent={ring.urgent}
          dim={member ? !member.connected : false}
        />
      </div>
      <span className="max-w-full truncate text-xs font-semibold sm:text-sm">{name}</span>
      <div className="flex items-center gap-1">
        <CardBackFan count={player.handCount} />
        <span
          className="min-w-5 rounded-pill bg-white/8 px-1 text-center text-[11px] font-bold tabular-nums text-muted"
          aria-label={t.table.cards(player.handCount)}
        >
          {player.handCount}
        </span>
      </div>
      <PlayerBadges player={player} view={view} member={member} />
    </li>
  );
}

/** The viewer's own strip above the hand: avatar with ring, name and pills. */
export function MySeat({
  player,
  name,
  view,
  member,
  ring,
}: {
  player: PublicPlayer;
  name: string;
  view: PlayerView;
  member: RoomMember | undefined;
  ring: TurnRing;
}) {
  const anchor = useAnchor(anchorKey.seat(player.id));
  return (
    <div className="flex items-center justify-center gap-2" data-testid={`seat-${player.id}`}>
      <div ref={anchor}>
        <Avatar id={player.id} name={name} size={30} progress={ring.progress} urgent={ring.urgent} />
      </div>
      <span className="text-sm font-semibold">{name}</span>
      <PlayerBadges player={player} view={view} member={member} />
    </div>
  );
}
