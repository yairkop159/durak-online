import { resign } from '@durak/game-engine';
import { departureKind, type DepartureKind, type PlayerId } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, RoomMember, StoredGame } from '../domain/types.js';
import type { GameCommitter } from './GameCommitter.js';
import { isOut } from './TurnTimerService.js';

/** Difficulty of the bot that takes over a seat whose human left (same as the AFK takeover). */
export const LEAVE_TAKEOVER_DIFFICULTY = 'medium' as const;

/** A human who still holds their seat (not a bot, and did not leave the game). */
export const isActiveHuman = (m: RoomMember): boolean => !m.isBot && !m.leftGame;

/**
 * The host after `leaverId` gives up their seat: unchanged unless the leaver was the host, then
 * the first active human. The host is always an active human; bots and leavers never inherit it.
 */
export function nextHost(hostId: string, leaverId: string, members: readonly RoomMember[]): string {
  const current = members.find((m) => m.playerId === hostId);
  if (hostId !== leaverId && current && isActiveHuman(current)) return hostId;
  return members.find((m) => m.playerId !== leaverId && isActiveHuman(m))?.playerId ?? hostId;
}

/** The shared departure rule (`departureKind`) applied to a stored room + game. */
export function departureOutcome(room: Room, game: StoredGame | null, playerId: PlayerId): DepartureKind {
  const running = room.status === 'playing' && !!game && game.state.phase.kind !== 'finished';
  return departureKind({
    running,
    leaverId: playerId,
    seats: (game?.state.players ?? []).map((p) => {
      const member = room.members.find((m) => m.playerId === p.id);
      return { playerId: p.id, isHuman: !!member && !member.isBot && !member.leftGame, isOut: !!game && isOut(game.state, p.id) };
    }),
  });
}

/** A human seat turned into a bot seat for the rest of the game (same id and nickname). */
export function takeoverMember(member: RoomMember): RoomMember {
  return {
    ...member,
    isBot: true,
    botDifficulty: LEAVE_TAKEOVER_DIFFICULTY,
    leftGame: true,
    connected: true,
    afk: false,
    consecutiveTimeouts: 0,
    graceDeadline: null,
  };
}

export interface DepartInput {
  readonly room: Room;
  readonly game: StoredGame;
  readonly playerId: PlayerId;
  /** A voluntary leave (the seat is marked `leftGame` even when the game ends); false = grace expiry. */
  readonly voluntary: boolean;
}

/**
 * Applies a departure that affects the game (`resign` or `takeover`) through the single commit
 * path; must be called inside the room lock. The departing player is recorded in `forfeits`.
 * Returns the outcome so callers can do their own bookkeeping; `none` writes nothing.
 */
export async function departSeat(
  committer: GameCommitter,
  input: DepartInput,
): Promise<Result<{ kind: DepartureKind; room: Room; game: StoredGame | null }>> {
  const { room, game, playerId, voluntary } = input;
  const kind = departureOutcome(room, game, playerId);
  if (kind === 'none') return ok({ kind, room, game: null });

  const forfeits = game.forfeits.includes(playerId) ? game.forfeits : [...game.forfeits, playerId];
  if (kind === 'resign') {
    const resigned = resign(game.state, playerId);
    if (!resigned.ok) return fail(resigned.error.code, resigned.error.message);
    const members = room.members.map((m) =>
      m.playerId === playerId
        ? { ...m, graceDeadline: null, ...(voluntary ? { connected: false, leftGame: true } : {}) }
        : m,
    );
    const committed = await committer.commit({
      room: { ...room, members, hostId: nextHost(room.hostId, playerId, members) },
      roomChanged: true,
      prev: game,
      state: resigned.value,
      endReason: 'forfeit',
      forfeits,
    });
    return ok({ kind, ...committed });
  }

  // Takeover: the game state is unchanged, but the version bumps so every client gets the new
  // seat (room:state + game:state) and the BotDriver starts planning for it.
  const members = room.members.map((m) => (m.playerId === playerId ? takeoverMember(m) : m));
  const botAssisted = game.botAssisted.includes(playerId) ? game.botAssisted : [...game.botAssisted, playerId];
  const committed = await committer.commit({
    room: { ...room, members, hostId: nextHost(room.hostId, playerId, members) },
    roomChanged: true,
    prev: game,
    state: game.state,
    forfeits,
    botAssisted,
  });
  return ok({ kind, ...committed });
}
