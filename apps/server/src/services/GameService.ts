import { applyMove } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier } from './ports.js';

export interface GameServiceDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
}

export class GameService {
  constructor(private readonly deps: GameServiceDeps) {}

  /**
   * Applies a move for the session's player. The acting player id comes ONLY from the
   * server-side session; the payload cannot name a player.
   */
  async makeMove(
    session: Session,
    roomId: string,
    move: ClientMove,
    expectedVersion: number,
  ): Promise<Result<StoredGame>> {
    if (session.roomId !== roomId || session.role !== 'player') {
      return fail('NOT_IN_ROOM', 'You are not a player in this room');
    }
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(roomId, async () => {
      const room = await repos.rooms.get(roomId);
      const game = await repos.games.get(roomId);
      if (!room || !game) return fail('GAME_NOT_STARTED', 'No game is running in this room');
      if (expectedVersion !== game.version) {
        return fail('STALE_STATE', `Expected version ${game.version}, got ${expectedVersion}`);
      }

      const result = applyMove(game.state, { ...move, playerId: session.id });
      if (!result.ok) return fail(result.error.code, result.error.message);

      const next: StoredGame = { ...game, version: game.version + 1, state: result.value };
      const finished = next.state.phase.kind === 'finished';
      const updatedRoom = finished ? { ...room, status: 'finished' as const } : room;
      if (finished) {
        await repos.atomic.saveRoomAndGame(updatedRoom, next);
      } else {
        await repos.games.save(next);
      }

      notifier.gameState(updatedRoom, next);
      if (finished) notifier.gameOver(updatedRoom, next);
      return ok(next);
    });
  }

  /** Re-sends the caller their current view (after a STALE_STATE rejection), in lock order. */
  async resync(session: Session): Promise<void> {
    const { repos, mutex, notifier } = this.deps;
    await mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      const game = await repos.games.get(session.roomId);
      if (room && game) notifier.sendGameStateTo(room, game, session);
    });
  }
}
