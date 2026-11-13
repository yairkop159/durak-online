import type { PlayerView, PublicPlayer, RoomMember } from '@durak/shared';

/**
 * Everyone except the viewer, in clockwise order starting from the seat after the viewer
 * (for a spectator: everyone, starting from seat 0).
 */
export function opponentsInOrder(view: PlayerView): PublicPlayer[] {
  const players = view.players;
  const me = players.findIndex((p) => p.id === view.viewerId);
  if (me === -1) return [...players];
  return [...players.slice(me + 1), ...players.slice(0, me)];
}

export function nicknameOf(playerId: string, members: readonly RoomMember[] | undefined): string {
  return members?.find((m) => m.playerId === playerId)?.nickname ?? '?';
}
