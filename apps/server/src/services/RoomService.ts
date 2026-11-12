import { createGame } from '@durak/game-engine';
import type { GameConfigInput } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier, SessionBinder } from './ports.js';
import { newPlayerId, newRoomId, newSessionToken, newSpectatorId, type SeedSource } from './random.js';

export interface RoomServiceDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly seedSource: SeedSource;
  readonly now: () => number;
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
        members: [{ playerId, nickname: input.nickname, connected: true, isBot: false }],
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
          members: [...room.members, { playerId, nickname, connected: true, isBot: false }],
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

  /** Lobby-only for players (forfeiting a running game arrives in Phase 3c). */
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
        await repos.rooms.delete(room.id);
        await repos.games.delete(room.id);
      } else {
        await repos.rooms.save(updated);
      }
      notifier.roomState(updated);
      return ok(undefined);
    });
  }

  /** Re-attaches a connection to an existing session and re-sends everything it needs. */
  async resume(token: string, bind: SessionBinder): Promise<Result<Session>> {
    const { repos, mutex, notifier } = this.deps;
    const session = await repos.sessions.get(token);
    if (!session) return fail('INVALID_SESSION', 'Unknown or expired session');

    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      const updated: Room =
        session.role === 'player'
          ? {
              ...room,
              members: room.members.map((m) => (m.playerId === session.id ? { ...m, connected: true } : m)),
            }
          : room;
      await repos.rooms.save(updated);
      bind(session);
      notifier.roomState(updated);
      const game = await repos.games.get(session.roomId);
      if (game) notifier.sendGameStateTo(updated, game, session);
      return ok(session);
    });
  }

  /**
   * Marks a player as disconnected. `isStillOffline` is evaluated inside the lock so a
   * resume that raced ahead of us is respected.
   */
  async markDisconnected(session: Session, isStillOffline: () => Promise<boolean>): Promise<void> {
    if (session.role !== 'player') return;
    const { repos, mutex, notifier } = this.deps;
    await mutex.runExclusive(session.roomId, async () => {
      if (!(await isStillOffline())) return;
      const room = await repos.rooms.get(session.roomId);
      if (!room) return;
      const member = room.members.find((m) => m.playerId === session.id);
      if (!member || !member.connected) return;
      const updated: Room = {
        ...room,
        members: room.members.map((m) => (m.playerId === session.id ? { ...m, connected: false } : m)),
      };
      await repos.rooms.save(updated);
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

      const game: StoredGame = { roomId: room.id, seed, version: 0, state: created.value, startedAt: this.deps.now() };
      const updated: Room = { ...room, status: 'playing' };
      await repos.games.save(game);
      await repos.rooms.save(updated);
      notifier.roomState(updated);
      notifier.gameState(updated, game);
      return ok(game);
    });
  }

  private async unusedRoomId(): Promise<string> {
    for (;;) {
      const id = newRoomId();
      if (!(await this.deps.repos.rooms.get(id))) return id;
    }
  }
}
