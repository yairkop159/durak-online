import type { PlayerView, PublicPlayer, RoomMember } from '@durak/shared';
import type { ReactNode } from 'react';
import { anchorKey, useAnchor } from '../../anim/anchors';
import { CardBackFan } from '../../components/cards/CardBack';
import { Avatar } from '../../components/ui';
import { t } from '../../i18n';
import type { ClientReaction } from '../../net/store';
import { ReactionBubble } from '../../reactions/ReactionBubble';
import type { SeatEffect as SeatEffectKind } from '../../anim/moments';
import { SeatEffect } from '../../moments/MomentBanner';

/** The moment effect on a seat right now (the id re-runs it for a new moment), or null. */
export type SeatEffectProp = { readonly kind: SeatEffectKind; readonly id: number } | null;
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
  reaction = null,
  effect = null,
  reduced = false,
}: {
  player: PublicPlayer;
  name: string;
  view: PlayerView;
  member: RoomMember | undefined;
  ring: TurnRing;
  /** The player's latest quick reaction, shown as a bubble above the avatar. */
  reaction?: ClientReaction | null;
  effect?: SeatEffectProp;
  reduced?: boolean;
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
        {effect && <SeatEffect key={effect.id} effect={effect.kind} momentId={effect.id} reduced={reduced} />}
        {reaction && <ReactionBubble key={reaction.id} reaction={reaction} />}
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

/** The viewer's own strip above the hand: avatar with ring, name, pills and the reaction button. */
export function MySeat({
  player,
  name,
  view,
  member,
  ring,
  reaction = null,
  effect = null,
  reduced = false,
  extra,
}: {
  player: PublicPlayer;
  name: string;
  view: PlayerView;
  member: RoomMember | undefined;
  ring: TurnRing;
  reaction?: ClientReaction | null;
  effect?: SeatEffectProp;
  reduced?: boolean;
  /** E.g. the quick-reaction button. */
  extra?: ReactNode;
}) {
  const anchor = useAnchor(anchorKey.seat(player.id));
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={`seat-${player.id}`}>
      <div ref={anchor} className="relative">
        <Avatar id={player.id} name={name} size={30} progress={ring.progress} urgent={ring.urgent} />
        {effect && <SeatEffect key={effect.id} effect={effect.kind} momentId={effect.id} reduced={reduced} />}
        {reaction && <ReactionBubble key={reaction.id} reaction={reaction} />}
      </div>
      <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
      <PlayerBadges player={player} view={view} member={member} />
      {extra}
    </div>
  );
}
