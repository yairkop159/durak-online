import type { PlayerId } from '@durak/shared';
import type { RestartVote, Room, RoomMember } from '../domain/types.js';

/** A human who can answer a vote right now: seated, connected, not AFK, did not leave. */
export function canVote(member: RoomMember): boolean {
  return !member.isBot && !member.leftGame && member.connected && !member.afk;
}

/**
 * Who must agree in this room. Normally: every other human who can vote right now (bots and
 * absent humans don't block). In a running tournament: every other human seat that hasn't left,
 * offline and AFK ones included, so a restart (which erases the game from the series) needs a
 * unanimous yes; a voter who can't answer lets the vote expire.
 */
function isVoter(room: Room, member: RoomMember): boolean {
  if (room.tournament?.status === 'running') return !member.isBot && !member.leftGame;
  return canVote(member);
}

/** The voters of a new vote (see `isVoter`). */
export function votersFor(room: Room, proposerId: PlayerId): PlayerId[] {
  return room.members.filter((m) => m.playerId !== proposerId && isVoter(room, m)).map((m) => m.playerId);
}

export type VoteStatus =
  | { readonly kind: 'open'; readonly vote: RestartVote }
  | { readonly kind: 'passed'; readonly vote: RestartVote }
  | { readonly kind: 'cancelled'; readonly vote: RestartVote };

/**
 * Re-evaluates an open vote against the room as it is now (pure):
 * - the proposer no longer holds a human seat (left, or the game was taken over) -> cancelled;
 * - voters who are no longer voters are dropped: offline, AFK or left normally (absent humans
 *   never block); in a running tournament only those who left;
 * - every remaining voter accepted -> passed.
 */
export function settleVote(room: Room, vote: RestartVote): VoteStatus {
  const proposer = room.members.find((m) => m.playerId === vote.proposerId);
  if (!proposer || proposer.isBot || proposer.leftGame) return { kind: 'cancelled', vote };
  const voters = vote.voters.filter((id) => {
    const m = room.members.find((member) => member.playerId === id);
    return !!m && isVoter(room, m);
  });
  const settled: RestartVote = { ...vote, voters, accepted: vote.accepted.filter((id) => voters.includes(id)) };
  if (voters.every((id) => settled.accepted.includes(id))) return { kind: 'passed', vote: settled };
  return { kind: 'open', vote: settled };
}

/** Drops cooldown entries that are over. */
export function pruneCooldowns(cooldowns: Room['restartCooldowns'], now: number): Record<PlayerId, number> {
  return Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now));
}
