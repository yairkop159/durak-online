import type { GameEndReason } from '@durak/shared';
import type { Room, StoredGame } from '../domain/types.js';
import type { GameResultInput, ResultSeat } from './gameResult.js';

/**
 * The match-history snapshot of a finished game: built synchronously inside the room lock from
 * the exact room and game the committer just saved, so the Postgres write can happen later.
 * Returns null when no profiled human played (nothing to store).
 *
 * - Seats follow the engine's seating order (`state.players`).
 * - A seat is a bot only if it was a bot from the start: a leave takeover turns a human seat into
 *   `isBot`, but that player is in `botAssisted` and is still a human with their profile.
 * - Profiles come from the deal-time snapshot (`game.profiles`), never from the room.
 */
export function buildResultInput(
  room: Room,
  game: StoredGame,
  endedAt: number,
  endReason: GameEndReason = game.endReason ?? 'normal',
): GameResultInput | null {
  const { state } = game;
  const seats: ResultSeat[] = state.players.map((player, seat) => {
    const member = room.members.find((m) => m.playerId === player.id);
    const botAssisted = game.botAssisted.includes(player.id);
    return {
      seat,
      playerId: player.id,
      nickname: member?.nickname ?? '?',
      isBot: (member?.isBot ?? false) && !botAssisted,
      profileId: game.profiles[player.id] ?? null,
      botAssisted,
      forfeited: game.forfeits.includes(player.id),
    };
  });
  if (!seats.some((s) => !s.isBot && s.profileId !== null)) return null;
  return {
    gameId: game.gameId,
    roomId: room.id,
    mode: state.config.mode,
    startedAt: game.startedAt,
    endedAt,
    endReason,
    durakId: state.phase.kind === 'finished' ? state.phase.durak : null,
    seats,
  };
}
