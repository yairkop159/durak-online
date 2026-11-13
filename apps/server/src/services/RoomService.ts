import { createGame, getAwaitedPlayers } from '@durak/game-engine';
import type { BotDifficulty, GameConfigInput } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, RoomMember, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameCommitter } from './GameCommitter.js';
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
  readonly committer: GameCommitter;
}

function newMember(playerId: string, nickname: string): RoomMember {
  return {
    playerId,
    nickname,
    connected: true,
    isBot: false,
    botDifficulty: null,
    afk: false,
    consecutiveTimeouts: 0,
    graceDeadline: null,
  };
}

/** The only way to build a bot seat: always connected, never AFK, no grace, no session. */
export function newBotMember(playerId: string, nickname: string, difficulty: BotDifficulty): RoomMember {
  return {
    playerId,
    nickname,
    connected: true,
    isBot: true,
    botDifficulty: difficulty,
    afk: false,
    consecutiveTimeouts: 0,
    graceDeadline: null,
  };
}

/** "Bot N" with the smallest N not used by another bot seat. */
function nextBotNickname(members: readonly RoomMember[]): string {
  const used = new Set(members.filter((m) => m.isBot).map((m) => m.nickname));
  for (let n = 1; ; n++) if (!used.has(`Bot ${n}`)) return `Bot ${n}`;
}

const hasHuman = (members: readonly RoomMember[]): boolean => members.some((m) => !m.isBot);

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
        // The host is always a human; bots never inherit it.
        const hostId =
          room.hostId === session.id ? (members.find((m) => !m.isBot)?.playerId ?? room.hostId) : room.hostId;
        updated = { ...room, members, hostId };
      }
      await repos.sessions.delete(session.token);

      // A room always contains at least one human: with only bots left it is deleted.
      if (!hasHuman(updated.members)) {
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
      // AFK was cleared: the bot stops playing for this player.
      const current = extendedGame ?? game;
      if (session.role === 'player' && current && room.status === 'playing') {
        this.deps.committer.announce(updated, current, null);
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
      if (!member || member.isBot || !member.connected) return;
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
    const { repos, mutex } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) {
        return fail('NOT_HOST', 'Only the host can start the game');
      }
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'The game has already started');
      if (room.members.length < 2) return fail('NOT_ENOUGH_PLAYERS', 'At least 2 players are needed');
      if (!hasHuman(room.members)) return fail('NO_HUMANS', 'A game needs at least one human player');

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
        turnDeadline: null, // set by the committer
        timeoutStreak: 0,
        endReason: null,
        knowledge: {}, // set by the committer
        botAssisted: [],
      };
      return ok(await this.deps.committer.start(updated, game));
    });
  }

  /** Host only, lobby only: seats a bot with a server-generated id. */
  async addBot(session: Session, difficulty: BotDifficulty): Promise<Result<RoomMember>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) return fail('NOT_HOST', 'Only the host can add bots');
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'Bots can only be added in the lobby');
      if (room.members.length >= room.maxPlayers) return fail('ROOM_FULL', 'The room is full');

      const bot = newBotMember(newPlayerId(), nextBotNickname(room.members), difficulty);
      const updated: Room = { ...room, members: [...room.members, bot] };
      await repos.rooms.save(updated);
      notifier.roomState(updated);
      return ok(bot);
    });
  }

  /** Host only, lobby only: removes a bot seat (never a human). */
  async removeBot(session: Session, playerId: string): Promise<Result<void>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) return fail('NOT_HOST', 'Only the host can remove bots');
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'Bots can only be removed in the lobby');
      if (!room.members.some((m) => m.playerId === playerId && m.isBot)) return fail('NOT_A_BOT', 'That seat is not a bot');

      const updated: Room = { ...room, members: room.members.filter((m) => m.playerId !== playerId) };
      await repos.rooms.save(updated);
      notifier.roomState(updated);
      return ok(undefined);
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
