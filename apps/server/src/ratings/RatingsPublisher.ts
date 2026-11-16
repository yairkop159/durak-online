import type { RatingEntry } from '@durak/shared';
import type { Repositories } from '../repositories/interfaces.js';
import type { KeyedMutex } from '../services/KeyedMutex.js';
import type { RoomNotifier } from '../services/ports.js';
import type { GameResultInput } from './gameResult.js';

/**
 * Announces a committed rating change (ResultQueue.onRecorded: only after a write that this
 * process committed and rated, so a duplicate or a retry never announces twice).
 *
 * Inside the room lock: the finished game still in Redis gets `ratings` (so a reload shows them)
 * through `replaceKeepingTtl`: no version bump, no GameCommitter and no listeners, and the game
 * keeps its remaining finished TTL. Then the whole room gets `game:ratings`. Dropped when the
 * game is gone or replaced (rematch, restart vote, expiry) or already annotated.
 */
export class RatingsPublisher {
  constructor(
    private readonly deps: {
      readonly repos: Repositories;
      readonly mutex: KeyedMutex;
      readonly notifier: RoomNotifier;
    },
  ) {}

  /** True when stored and announced. */
  async publish(input: GameResultInput, ratings: readonly RatingEntry[]): Promise<boolean> {
    const { repos, mutex, notifier } = this.deps;
    if (ratings.length < 2) return false;
    return mutex.runExclusive(input.roomId, async () => {
      const game = await repos.games.get(input.roomId);
      if (!game || game.gameId !== input.gameId || game.state.phase.kind !== 'finished' || game.ratings !== null) return false;
      const room = await repos.rooms.get(input.roomId);
      if (!room) return false;
      if (!(await repos.games.replaceKeepingTtl({ ...game, ratings: [...ratings] }))) return false;
      notifier.gameRatings(room, { roomId: room.id, gameId: game.gameId, status: 'rated', entries: [...ratings] });
      return true;
    });
  }
}
