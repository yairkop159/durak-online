import type { GameRatingsPayload } from '@durak/shared';
import type { Room, StoredGame } from '../domain/types.js';
import { endReasonIsRated, isRated, teamsHaveFourHumans } from './gameResult.js';
import { buildResultInput } from './resultInput.js';

/**
 * The `game:ratings` payload for a finished game, derived from what is stored (pure):
 * 1. the committed changes are on the game (`game.ratings`) → `rated`;
 * 2. ratings are not available (not configured, or Postgres was not ready) → null: show nothing;
 * 3. abandoned / restarted → `unrated` / `notFinished`;
 * 4. a team game without four profiled humans → `unrated` / `teamsNeedFourHumans`;
 *    otherwise fewer than two profiled humans → `unrated` / `notEnoughProfiles`;
 * 5. otherwise → `pending` (the write has not committed yet).
 * Null for a game that is not finished. Profiles come from the deal-time snapshot, like the history.
 */
export function ratingStatusFor(room: Room, game: StoredGame, ratingsAvailable: boolean): GameRatingsPayload | null {
  if (game.state.phase.kind !== 'finished') return null;
  const base = { roomId: room.id, gameId: game.gameId };
  if (game.ratings !== null && game.ratings.length >= 2) return { ...base, status: 'rated', entries: [...game.ratings] };
  if (!ratingsAvailable) return null;
  if (!endReasonIsRated(game.endReason ?? 'normal')) return { ...base, status: 'unrated', reason: 'notFinished' };
  const input = buildResultInput(room, game, 0);
  if (game.state.config.teams === true && (input === null || !teamsHaveFourHumans(input))) {
    return { ...base, status: 'unrated', reason: 'teamsNeedFourHumans' };
  }
  if (input === null || !isRated(input)) return { ...base, status: 'unrated', reason: 'notEnoughProfiles' };
  return { ...base, status: 'pending' };
}
