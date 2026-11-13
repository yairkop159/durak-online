import { departureKind, type DepartureKind, type PlayerView, type RoomMember } from '@durak/shared';

/**
 * What leaving now would do to the viewer, computed from the public room + view with the same
 * rule the server applies (`departureKind` in @durak/shared).
 */
export function leaveOutcome(view: PlayerView, members: readonly RoomMember[] | undefined): DepartureKind {
  if (view.viewerId === null) return 'none';
  return departureKind({
    running: view.phase.kind !== 'finished',
    leaverId: view.viewerId,
    seats: view.players.map((p) => {
      const member = members?.find((m) => m.playerId === p.id);
      return { playerId: p.id, isHuman: !!member && !member.isBot && !member.leftGame, isOut: p.finished };
    }),
  });
}
