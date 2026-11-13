import { applyMove } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameCommitter } from './GameCommitter.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier } from './ports.js';

export interface GameServiceDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly committer: GameCommitter;
}

/** Where the BotDriver sends its decisions (implemented by GameService). */
export interface AutomatedMoveSink {
  applyAutomatedMove(roomId: string, playerId: string, move: ClientMove, expectedVersion: number): Promise<Result<StoredGame>>;
}

export class GameService implements AutomatedMoveSink {
  constructor(private readonly deps: GameServiceDeps) {}

  /**
   * Applies a move for the session's player. The acting player id comes ONLY from the
   * server-side session; the payload cannot name a player.
   * A human move clears the actor's AFK state (handing control back from the bot), resets the
   * abandon guard, and restarts the turn timer.
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
    const { repos, mutex, committer } = this.deps;
    return mutex.runExclusive(roomId, async () => {
      const room = await repos.rooms.get(roomId);
      const game = await repos.games.get(roomId);
      if (!room || !game) return fail('GAME_NOT_STARTED', 'No game is running in this room');
      if (expectedVersion !== game.version) {
        return fail('STALE_STATE', `Expected version ${game.version}, got ${expectedVersion}`);
      }

      const result = applyMove(game.state, { ...move, playerId: session.id });
      if (!result.ok) return fail(result.error.code, result.error.message);

      const actor = room.members.find((m) => m.playerId === session.id);
      const actorReset = !!actor && (actor.afk || actor.consecutiveTimeouts > 0);
      const updatedRoom: Room = actorReset
        ? {
            ...room,
            members: room.members.map((m) => (m.playerId === session.id ? { ...m, afk: false, consecutiveTimeouts: 0 } : m)),
          }
        : room;
      const { game: next } = await committer.commit({
        room: updatedRoom,
        roomChanged: actorReset,
        prev: game,
        state: result.value,
        timeoutStreak: 0,
      });
      return ok(next);
    });
  }

  /**
   * A bot decision for `playerId` (a bot seat, or an AFK human the bot plays for), planned against
   * `expectedVersion`. Same lock, version check and engine path as a human move, but it does NOT
   * reset the abandon guard or anyone's AFK state. A seat no longer under bot control is rejected.
   */
  async applyAutomatedMove(
    roomId: string,
    playerId: string,
    move: ClientMove,
    expectedVersion: number,
  ): Promise<Result<StoredGame>> {
    const { repos, mutex, committer } = this.deps;
    return mutex.runExclusive(roomId, async () => {
      const room = await repos.rooms.get(roomId);
      const game = await repos.games.get(roomId);
      if (!room || !game || room.status !== 'playing') return fail('GAME_NOT_STARTED', 'No game is running in this room');
      if (expectedVersion !== game.version) {
        return fail('STALE_STATE', `Expected version ${game.version}, got ${expectedVersion}`);
      }
      const member = room.members.find((m) => m.playerId === playerId);
      if (!member || !(member.isBot || member.afk)) {
        return fail('NOT_IN_ROOM', 'This seat is not under bot control');
      }

      const result = applyMove(game.state, { ...move, playerId });
      if (!result.ok) return fail(result.error.code, result.error.message);

      const assisted = !member.isBot && !game.botAssisted.includes(playerId);
      const { game: next } = await committer.commit({
        room,
        roomChanged: false,
        prev: game,
        state: result.value,
        ...(assisted ? { botAssisted: [...game.botAssisted, playerId] } : {}),
      });
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
