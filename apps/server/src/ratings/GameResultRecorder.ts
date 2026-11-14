import type { GameState } from '@durak/game-engine';
import type { Room, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameChangeListener } from '../services/ports.js';
import type { Clock } from '../services/scheduling.js';
import type { ResultQueue } from './ResultQueue.js';
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
 */
export class GameResultRecorder implements GameChangeListener {
  constructor(
    private readonly deps: {
      readonly queue: ResultQueue;
      readonly clock: Clock;
      /** False when Postgres is not configured: nothing is queued at all. */
      readonly enabled: () => boolean;
    },
  ) {}

  onGameChanged(room: Room, game: StoredGame, prev: GameState | null): void {
    if (prev === null || prev.phase.kind === 'finished') return;
    if (game.state.phase.kind !== 'finished') return;
    this.recordEnded(room, game);
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
