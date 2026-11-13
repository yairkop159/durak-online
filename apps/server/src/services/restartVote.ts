import type { PlayerId } from '@durak/shared';
import type { RestartVote, Room, RoomMember } from '../domain/types.js';

/** A human who can answer a vote right now: seated, connected, not AFK, did not leave. */
export function canVote(member: RoomMember): boolean {
  return !member.isBot && !member.leftGame && member.connected && !member.afk;
}

/** The voters of a new vote: every other member who can vote. Bots and absent humans don't block. */
export function votersFor(room: Room, proposerId: PlayerId): PlayerId[] {
  return room.members.filter((m) => m.playerId !== proposerId && canVote(m)).map((m) => m.playerId);
}

export type VoteStatus =
  | { readonly kind: 'open'; readonly vote: RestartVote }
  | { readonly kind: 'passed'; readonly vote: RestartVote }
  | { readonly kind: 'cancelled'; readonly vote: RestartVote };

/**
 * Re-evaluates an open vote against the room as it is now (pure):
 * - the proposer no longer holds a human seat (left, or the game was taken over) -> cancelled;
 * - voters who went offline, AFK or left are dropped (absent humans never block);
 * - every remaining voter accepted -> passed.
 */
export function settleVote(room: Room, vote: RestartVote): VoteStatus {
  const proposer = room.members.find((m) => m.playerId === vote.proposerId);
  if (!proposer || proposer.isBot || proposer.leftGame) return { kind: 'cancelled', vote };
  const voters = vote.voters.filter((id) => {
    const m = room.members.find((member) => member.playerId === id);
    return !!m && canVote(m);
  });
  const settled: RestartVote = { ...vote, voters, accepted: vote.accepted.filter((id) => voters.includes(id)) };
  if (voters.every((id) => settled.accepted.includes(id))) return { kind: 'passed', vote: settled };
  return { kind: 'open', vote: settled };
}

/** Drops cooldown entries that are over. */
export function pruneCooldowns(cooldowns: Room['restartCooldowns'], now: number): Record<PlayerId, number> {
  return Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now));
}
