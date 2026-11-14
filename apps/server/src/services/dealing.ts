import { createGame } from '@durak/game-engine';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, StoredGame } from '../domain/types.js';
import { initialStats } from './gameStats.js';
import { newShortId } from './random.js';

/**
 * Deals a new game for `room` (seat order = members order, the room's config) and returns the
 * room as `playing` plus the version-0 game, ready for `GameCommitter.start`. Used by game:start
 * and by a passed restart vote. Members' AFK, timeout and grace state is reset.
 */
export function dealGame(room: Room, seed: number, now: number): Result<{ room: Room; game: StoredGame }> {
  const created = createGame({ playerIds: room.members.map((m) => m.playerId), seed, config: room.config });
  if (!created.ok) return fail(created.error.code, created.error.message);
  const updated: Room = {
    ...room,
    status: 'playing',
    restartVote: null,
    members: room.members.map((m) => (m.isBot ? m : { ...m, afk: false, consecutiveTimeouts: 0 })),
  };
  const game: StoredGame = {
    roomId: room.id,
    gameId: newShortId(),
    seed,
    version: 0,
    state: created.value,
    startedAt: now,
    turnDeadline: null, // set by the committer
    timeoutStreak: 0,
    endReason: null,
    knowledge: {}, // set by the committer
    botAssisted: [],
    forfeits: [],
    stats: initialStats(created.value),
  };
  return ok({ room: updated, game });
}
