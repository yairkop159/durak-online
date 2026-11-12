import type { Room, StoredGame } from '../domain/types.js';

/** Sliding TTL policy shared by every repository implementation. Refreshed on every save. */
export const ACTIVE_TTL_SECONDS = 6 * 60 * 60;
export const FINISHED_TTL_SECONDS = 30 * 60;
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function roomTtlSeconds(room: Room): number {
  return room.status === 'finished' ? FINISHED_TTL_SECONDS : ACTIVE_TTL_SECONDS;
}

export function gameTtlSeconds(game: StoredGame): number {
  return game.state.phase.kind === 'finished' ? FINISHED_TTL_SECONDS : ACTIVE_TTL_SECONDS;
}
