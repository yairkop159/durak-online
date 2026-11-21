import type { Room, StoredGame } from '../domain/types.js';

/** Sliding TTL policy shared by every repository implementation. Refreshed on every save. */
export const ACTIVE_TTL_SECONDS = 6 * 60 * 60;
export const FINISHED_TTL_SECONDS = 30 * 60;
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * A finished room keeps the short TTL, except between games of a running tournament: the series
 * is still on (a break between games must not expire it), so it keeps the active TTL until the
 * series is finished or ended early.
 */
export function roomTtlSeconds(room: Room): number {
  if (room.tournament?.status === 'running') return ACTIVE_TTL_SECONDS;
  return room.status === 'finished' ? FINISHED_TTL_SECONDS : ACTIVE_TTL_SECONDS;
}

export function gameTtlSeconds(game: StoredGame): number {
  return game.state.phase.kind === 'finished' ? FINISHED_TTL_SECONDS : ACTIVE_TTL_SECONDS;
}
