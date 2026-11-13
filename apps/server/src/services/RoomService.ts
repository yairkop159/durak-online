import { createGame, getAwaitedPlayers } from '@durak/game-engine';
import type { GameConfigInput } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, RoomMember, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier, SessionBinder } from './ports.js';
import { newPlayerId, newRoomId, newSessionToken, newSpectatorId, type SeedSource } from './random.js';
import { isOut, type TurnTimerService } from './TurnTimerService.js';

export interface RoomServiceDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly seedSource: SeedSource;
  readonly now: () => number;
  readonly timers: TurnTimerService;
}

function newMember(playerId: string, nickname: string): RoomMember {
  return { playerId, nickname, connected: true, isBot: false, afk: false, consecutiveTimeouts: 0, graceDeadline: null };
}

export interface CreateRoomInput {
  readonly nickname: string;
  readonly maxPlayers: number;
  readonly config?: GameConfigInput | undefined;
}

export class RoomService {
  constructor(private readonly deps: RoomServiceDeps) {}

  async getRoom(roomId: string): Promise<Room | null> {
    return this.deps.repos.rooms.get(roomId);
  }

  async getSession(token: string): Promise<Session | null> {
    return this.deps.repos.sessions.get(token);
  }

  async createRoom(input: CreateRoomInput, bind: SessionBinder): Promise<Result<Session>> {
    const { repos, mutex, notifier } = this.deps;
    const roomId = await this.unusedRoomId();
    return mutex.runExclusive(roomId, async () => {
      const playerId = newPlayerId();
      const room: Room = {
        id: roomId,
        hostId: playerId,
        maxPlayers: input.maxPlayers,
        config: input.config ?? {},
        members: [newMember(playerId, input.nickname)],
        spectators: [],
        status: 'lobby',
        createdAt: this.deps.now(),
      };
      const session: Session = { token: newSessionToken(), roomId, role: 'player', id: playerId };
      await repos.rooms.save(room);
      await repos.sessions.create(session);
      bind(session);
      notifier.roomState(room);
      return ok(session);
    });
  }

  /** Seats the caller if the room is an open lobby; otherwise they join as a spectator. */
  async joinRoom(roomId: string, nickname: string, bind: SessionBinder): Promise<Result<Session>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(roomId, async () => {
      const room = await repos.rooms.get(roomId);
      if (!room) return fail('ROOM_NOT_FOUND', `Room ${roomId} does not exist`);

      let updated: Room;
      let session: Session;
      if (room.status === 'lobby' && room.members.length < room.maxPlayers) {
        const playerId = newPlayerId();
        updated = {
          ...room,
          members: [...room.members, newMember(playerId, nickname)],
        };
        session = { token: newSessionToken(), roomId, role: 'player', id: playerId };
      } else {
        const spectatorId = newSpectatorId();
        updated = { ...room, spectators: [...room.spectators, { spectatorId, nickname }] };
        session = { token: newSessionToken(), roomId, role: 'spectator', id: spectatorId };
      }
      await repos.rooms.save(updated);
      await repos.sessions.create(session);
      bind(session);
      notifier.roomState(updated);
      if (session.role === 'spectator') {
        const game = await repos.games.get(roomId);
        if (game) notifier.sendGameStateTo(updated, game, session);
      }
      return ok(session);
    });
  }

  /** Lobby-only for players (a disconnected player forfeits via the reconnection grace instead). */
  async leaveRoom(session: Session): Promise<Result<void>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');

      let updated: Room;
      if (session.role === 'spectator') {
        updated = { ...room, spectators: room.spectators.filter((s) => s.spectatorId !== session.id) };
      } else {
        if (room.status === 'playing') {
          return fail('GAME_IN_PROGRESS', 'You cannot leave while the game is running');
        }
        const members = room.members.filter((m) => m.playerId !== session.id);
        const hostId = room.hostId === session.id ? (members[0]?.playerId ?? room.hostId) : room.hostId;
        updated = { ...room, members, hostId };
      }
      await repos.sessions.delete(session.token);

      if (updated.members.length === 0) {
        await repos.atomic.deleteRoomAndGame(room.id);
        this.deps.timers.cancelRoom(room.id);
      } else {
        await repos.rooms.save(updated);
      }
      notifier.roomState(updated);
      return ok(undefined);
    });
  }

  /**
   * Re-attaches a connection to an existing session and re-sends everything it needs.
   * For a player: cancels the reconnection grace and clears AFK. If the game is waiting on this
   * player, the turn deadline is extended to a full turn (no leftover short AFK deadline).
   */
  async resume(token: string, bind: SessionBinder): Promise<Result<Session>> {
    const { repos, mutex, notifier, timers } = this.deps;
    const session = await repos.sessions.get(token);
    if (!session) return fail('INVALID_SESSION', 'Unknown or expired session');

    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) {
        // Orphaned session (room expired or deleted): clean it up so it cannot be reused.
        await repos.sessions.delete(token);
        return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      }
      const updated: Room =
        session.role === 'player'
          ? {
              ...room,
              members: room.members.map((m) =>
                m.playerId === session.id
                  ? { ...m, connected: true, afk: false, consecutiveTimeouts: 0, graceDeadline: null }
                  : m,
              ),
            }
          : room;
      const game = await repos.games.get(session.roomId);

      // Extend the deadline if the game waits on this player and a full turn would be later.
      let extendedGame: StoredGame | null = null;
      if (
        session.role === 'player' &&
        game &&
        room.status === 'playing' &&
        game.turnDeadline !== null &&
        getAwaitedPlayers(game.state).includes(session.id)
      ) {
        const fresh = timers.deadlineFor(updated, game.state);
        if (fresh !== null && fresh > game.turnDeadline) extendedGame = { ...game, turnDeadline: fresh };
      }

      if (extendedGame) await repos.atomic.saveRoomAndGame(updated, extendedGame);
      else await repos.rooms.save(updated);
      if (session.role === 'player') timers.cancelGrace(session.roomId, session.id);
      bind(session);
      notifier.roomState(updated);
      if (extendedGame) {
        timers.armTurn(extendedGame);
        notifier.gameState(updated, extendedGame); // everyone sees the new deadline
      } else if (game) {
        notifier.sendGameStateTo(updated, game, session);
      }
      return ok(session);
    });
  }

  /**
   * Marks a player as disconnected. `isStillOffline` is evaluated inside the lock so a
   * resume that raced ahead of us is respected. In a running game where the player is still
   * in, this starts the reconnection grace; if it expires, the player forfeits.
   */
  async markDisconnected(session: Session, isStillOffline: () => Promise<boolean>): Promise<void> {
    if (session.role !== 'player') return;
    const { repos, mutex, notifier, timers } = this.deps;
    await mutex.runExclusive(session.roomId, async () => {
      if (!(await isStillOffline())) return;
      const room = await repos.rooms.get(session.roomId);
      if (!room) return;
      const member = room.members.find((m) => m.playerId === session.id);
      if (!member || !member.connected) return;
      const game = room.status === 'playing' ? await repos.games.get(session.roomId) : null;
      const needsGrace = !!game && game.state.phase.kind !== 'finished' && !isOut(game.state, session.id);
      const graceDeadline = needsGrace ? timers.newGraceDeadline() : null;
      const updated: Room = {
        ...room,
        members: room.members.map((m) => (m.playerId === session.id ? { ...m, connected: false, graceDeadline } : m)),
      };
      await repos.rooms.save(updated);
      if (graceDeadline !== null) timers.armGrace(session.roomId, session.id, graceDeadline);
      notifier.roomState(updated);
    });
  }

  async startGame(session: Session): Promise<Result<StoredGame>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) {
        return fail('NOT_HOST', 'Only the host can start the game');
      }
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'The game has already started');
      if (room.members.length < 2) return fail('NOT_ENOUGH_PLAYERS', 'At least 2 players are needed');

      const seed = this.deps.seedSource();
      const created = createGame({ playerIds: room.members.map((m) => m.playerId), seed, config: room.config });
      if (!created.ok) return fail(created.error.code, created.error.message);

      const updated: Room = { ...room, status: 'playing' };
      const game: StoredGame = {
        roomId: room.id,
        seed,
        version: 0,
        state: created.value,
        startedAt: this.deps.now(),
        turnDeadline: this.deps.timers.deadlineFor(updated, created.value),
        timeoutStreak: 0,
        endReason: null,
      };
      await repos.atomic.saveRoomAndGame(updated, game);
      this.deps.timers.armTurn(game);
      notifier.roomState(updated);
      notifier.gameState(updated, game);
      return ok(game);
    });
  }

  /**
   * Back to the lobby after a finished game: same members (AFK/grace state reset, offline members
   * keep their seat and can resume), the finished game is deleted. Idempotent: in the lobby it only
   * re-sends `room:state`, since every player may press "back to lobby".
   */
  async rematch(session: Session): Promise<Result<void>> {
    const { repos, mutex, notifier, timers } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || !room.members.some((m) => m.playerId === session.id)) {
        return fail('NOT_IN_ROOM', 'Only seated players can start a rematch');
      }
      if (room.status === 'playing') return fail('GAME_IN_PROGRESS', 'The game is still running');
      if (room.status === 'lobby') {
        notifier.roomState(room);
        return ok(undefined);
      }
      const updated: Room = {
        ...room,
        status: 'lobby',
        members: room.members.map((m) => ({ ...m, afk: false, consecutiveTimeouts: 0, graceDeadline: null })),
      };
      await repos.atomic.saveRoomDeleteGame(updated);
      timers.cancelRoom(room.id);
      notifier.roomState(updated);
      return ok(undefined);
    });
  }

  private async unusedRoomId(): Promise<string> {
    for (;;) {
      const id = newRoomId();
      if (!(await this.deps.repos.rooms.get(id))) return id;
    }
  }
}
