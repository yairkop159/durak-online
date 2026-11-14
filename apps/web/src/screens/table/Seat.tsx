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

/**
 * How an opponent seat is drawn: `regular` (avatar, name, a fan of backs, pills), `compact` (phones:
 * a narrow column, the card count on the avatar, no fan) or `inline` (short landscape screens: one
 * line, avatar beside the name, to fit the top bar).
 */
export type SeatVariant = 'regular' | 'compact' | 'inline';

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
  variant = 'regular',
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
  variant?: SeatVariant;
}) {
  const anchor = useAnchor(anchorKey.seat(player.id));
  const awaited = ring.progress !== null;
  const small = variant !== 'regular';
  const count = (
    <span
      className={
        small
          ? 'absolute -end-1 -bottom-0.5 z-10 min-w-4.5 rounded-pill bg-surface-3 px-1 text-center text-[10px] leading-4 font-bold tabular-nums text-text ring-1 ring-line-strong'
          : 'min-w-5 rounded-pill bg-white/8 px-1 text-center text-[11px] font-bold tabular-nums text-muted'
      }
      aria-label={t.table.cards(player.handCount)}
      data-testid={`count-${player.id}`}
    >
      {player.handCount}
    </span>
  );
  const avatar = (
    <div ref={anchor} className="relative shrink-0">
      <Avatar
        id={player.id}
        name={member?.isBot ? '🤖' : name}
        size={small ? 28 : 36}
        progress={ring.progress}
        urgent={ring.urgent}
        dim={member ? !member.connected : false}
      />
      {small && count}
      {effect && <SeatEffect key={`effect-${effect.id}`} effect={effect.kind} momentId={effect.id} reduced={reduced} />}
      {reaction && <ReactionBubble key={`reaction-${reaction.id}`} reaction={reaction} />}
    </div>
  );
  const frame = `${awaited ? 'bg-surface-2/90 ring-1 ring-accent/25' : 'bg-surface/60 ring-1 ring-line'} ${player.finished ? 'opacity-55' : ''}`;
  if (variant === 'inline') {
    return (
      <li data-testid={`seat-${player.id}`} dir="rtl" className={`flex min-w-0 items-center gap-1 rounded-xl py-0.5 ps-0.5 pe-1.5 transition-colors ${frame}`}>
        {avatar}
        <div className="flex min-w-0 flex-col items-start">
          <span className="max-w-[4.5rem] truncate text-[11px] leading-4 font-semibold">{name}</span>
          <PlayerBadges player={player} view={view} member={member} compact />
        </div>
      </li>
    );
  }
  return (
    <li
      data-testid={`seat-${player.id}`}
      dir="rtl"
      className={`flex flex-col items-center gap-0.5 rounded-2xl transition-colors ${
        small ? 'w-16 px-1 pt-1 pb-1.5' : 'w-[5.75rem] px-1.5 pt-1.5 pb-2 sm:w-28'
      } ${frame}`}
    >
      {avatar}
      <span className={`max-w-full truncate font-semibold ${small ? 'text-[11px] leading-4' : 'text-xs sm:text-sm'}`}>{name}</span>
      {!small && (
        <div className="flex items-center gap-1">
          <CardBackFan count={player.handCount} />
          {count}
        </div>
      )}
      <PlayerBadges player={player} view={view} member={member} compact={small} />
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
        {effect && <SeatEffect key={`effect-${effect.id}`} effect={effect.kind} momentId={effect.id} reduced={reduced} />}
        {reaction && <ReactionBubble key={`reaction-${reaction.id}`} reaction={reaction} />}
      </div>
      <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
      <PlayerBadges player={player} view={view} member={member} />
      {extra}
    </div>
  );
}
