import type { GameState } from '@durak/game-engine';
import type { GameRatingsPayload } from '@durak/shared';
import type { Room, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameChangeListener, RoomNotifier } from '../services/ports.js';
import type { Clock } from '../services/scheduling.js';
import type { ResultQueue } from './ResultQueue.js';
import { ratingStatusFor } from './ratingStatus.js';
import { buildResultInput } from './resultInput.js';

/**
 * Feeds finished games into the match history (Phase 10).
 * - As a GameChangeListener of the single write path (GameCommitter): every version that turns a
 *   game `finished` (a move, a timeout/abandon, a forfeit, the bots-only fast-forward) is
 *   snapshotted synchronously and queued. Nothing here awaits inside the room lock.
 * - A passed restart vote ends a game without a commit: RestartVoteService calls `recordEnded`.
 * - `resubmitFinished` re-queues every finished game still in the game store (startup, and when
 *   Postgres comes back), which covers a crash between game:over and the write. The store is
 *   idempotent by gameId, so this never rates twice.
 * - Right after `game:over` it tells the room the rating outcome as far as it is known (`pending`
 *   or `unrated`; nothing while ratings are unavailable). RatingsPublisher sends `rated` later.
 */
export class GameResultRecorder implements GameChangeListener {
  constructor(
    private readonly deps: {
      readonly queue: ResultQueue;
      readonly clock: Clock;
      /** False when Postgres is not configured: nothing is queued at all. */
      readonly enabled: () => boolean;
      /** Postgres is connected right now (default: true). False → no rating status is shown. */
      readonly ready?: () => boolean;
      /** Where the rating status goes (game:ratings); none → no status is sent. */
      readonly notifier?: RoomNotifier;
    },
  ) {}

  onGameChanged(room: Room, game: StoredGame, prev: GameState | null): void {
    if (prev === null || prev.phase.kind === 'finished') return;
    if (game.state.phase.kind !== 'finished') return;
    // Status first: the `rated` announcement needs this room's lock, which we hold, so it can only follow.
    const status = this.statusFor(room, game);
    if (status) this.deps.notifier?.gameRatings(room, status);
    this.recordEnded(room, game);
  }

  /** The game:ratings payload for a finished game right now (game end, resume), or null. */
  statusFor(room: Room, game: StoredGame): GameRatingsPayload | null {
    return ratingStatusFor(room, game, this.deps.enabled() && (this.deps.ready?.() ?? true));
  }

  recordEnded(room: Room, game: StoredGame): void {
    if (!this.deps.enabled()) return;
    const input = buildResultInput(room, game, this.deps.clock.now());
    if (input) this.deps.queue.enqueue(input);
  }

  async resubmitFinished(repos: Repositories): Promise<number> {
    if (!this.deps.enabled()) return 0;
    let count = 0;
    for await (const roomId of repos.rooms.scanIds()) {
      const room = await repos.rooms.get(roomId);
      if (!room || room.status !== 'finished') continue;
      const game = await repos.games.get(roomId);
      if (!game || game.state.phase.kind !== 'finished') continue;
      // The real end time is not stored; a crash-recovered game gets the re-submission time.
      const input = buildResultInput(room, game, this.deps.clock.now());
      if (!input) continue;
      this.deps.queue.enqueue(input);
      count++;
    }
    return count;
  }
}
