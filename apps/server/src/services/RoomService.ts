import { getAwaitedPlayers } from '@durak/game-engine';
import { isTeamGame, TEAM_GAME_PLAYERS, type BotDifficulty, type GameConfigInput, type GameRatingsPayload } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { Room, RoomMember, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameCommitter } from './GameCommitter.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier, SessionBinder } from './ports.js';
import type { RestartVoteService } from './RestartVoteService.js';
import { newPlayerId, newRoomId, newSessionToken, newSpectatorId, type SeedSource } from './random.js';
import { dealGame } from './dealing.js';
import { departSeat, isActiveHuman, nextHost } from './departure.js';
import { isOut, type TurnTimerService } from './TurnTimerService.js';

export interface RoomServiceDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly seedSource: SeedSource;
  readonly now: () => number;
  readonly timers: TurnTimerService;
  readonly committer: GameCommitter;
  /** Settles an open restart vote after a voter leaves or disconnects (optional in tests). */
  readonly votes?: RestartVoteService;
  /** Rooms stored at once; room:create beyond it fails with SERVER_FULL (default: unlimited). */
  readonly maxRooms?: number;
  /**
   * A finished game's rating outcome (GameResultRecorder.statusFor), re-sent after its game:state
   * on resume and to a spectator joining, so a reload still shows it. None → never sent.
   */
  readonly ratingStatus?: (room: Room, game: StoredGame) => GameRatingsPayload | null;
}

function newMember(playerId: string, nickname: string, profileId: string | null): RoomMember {
  return {
    playerId,
    nickname,
    connected: true,
    isBot: false,
    botDifficulty: null,
    afk: false,
    consecutiveTimeouts: 0,
    graceDeadline: null,
    leftGame: false,
    profileId,
    disconnectedAt: null,
  };
}

/**
 * One profile, one seat per room: a second seat with the same profile (two tabs share the
 * device's profile) is seated unprofiled — no error, it just isn't rated.
 */
function seatProfile(members: readonly RoomMember[], profileId: string | null): string | null {
  if (profileId === null) return null;
  return members.some((m) => m.profileId === profileId) ? null : profileId;
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
    leftGame: false,
    profileId: null,
    disconnectedAt: null,
  };
}

/** "Bot N" with the smallest N not used by another bot seat. */
function nextBotNickname(members: readonly RoomMember[]): string {
  const used = new Set(members.filter((m) => m.isBot).map((m) => m.nickname));
  for (let n = 1; ; n++) if (!used.has(`Bot ${n}`)) return `Bot ${n}`;
}

const hasHuman = (members: readonly RoomMember[]): boolean => members.some(isActiveHuman);

export interface CreateRoomInput {
  readonly nickname: string;
  readonly maxPlayers: number;
  readonly config?: GameConfigInput | undefined;
  /** Resolved from the device key before the call (Phase 10); null = unprofiled seat. */
  readonly profileId?: string | null | undefined;
}

export class RoomService {
  constructor(private readonly deps: RoomServiceDeps) {}

  /** Stored rooms, counting no further than `stopAt` (Redis: SCAN). */
  async countRooms(stopAt = Number.POSITIVE_INFINITY): Promise<number> {
    let count = 0;
    for await (const _id of this.deps.repos.rooms.scanIds()) {
      if (++count >= stopAt) break;
    }
    return count;
  }

  async getRoom(roomId: string): Promise<Room | null> {
    return this.deps.repos.rooms.get(roomId);
  }

  async getSession(token: string): Promise<Session | null> {
    return this.deps.repos.sessions.get(token);
  }

  async createRoom(input: CreateRoomInput, bind: SessionBinder): Promise<Result<Session>> {
    const { repos, mutex, notifier } = this.deps;
    const maxRooms = this.deps.maxRooms ?? Number.POSITIVE_INFINITY;
    // A soft cap: concurrent creates may overshoot it by a few, which is fine for abuse control.
    if (Number.isFinite(maxRooms) && (await this.countRooms(maxRooms)) >= maxRooms) {
      return fail('SERVER_FULL', 'The server is full, try again later');
    }
    if (input.config?.teams === true && input.maxPlayers !== TEAM_GAME_PLAYERS) {
      return fail('TEAMS_NEED_FOUR', `Team mode needs a ${TEAM_GAME_PLAYERS}-seat room`);
    }
    const roomId = await this.unusedRoomId();
    return mutex.runExclusive(roomId, async () => {
      const playerId = newPlayerId();
      const room: Room = {
        id: roomId,
        hostId: playerId,
        maxPlayers: input.maxPlayers,
        config: input.config ?? {},
        members: [newMember(playerId, input.nickname, input.profileId ?? null)],
        spectators: [],
        status: 'lobby',
        createdAt: this.deps.now(),
        restartVote: null,
        restartCooldowns: {},
        tournamentSetup: null,
        tournament: null,
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
  async joinRoom(
    roomId: string,
    nickname: string,
    bind: SessionBinder,
    profileId: string | null = null,
  ): Promise<Result<Session>> {
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
          members: [...room.members, newMember(playerId, nickname, seatProfile(room.members, profileId))],
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
        if (game) {
          notifier.sendGameStateTo(updated, game, session);
          this.sendRatingStatus(updated, game, session);
        }
      }
      return ok(session);
    });
  }

  /**
   * Leaves the room and ends the session. A player leaving a running game loses it
   * (`departSeat`): the game ends (forfeit), or in 3+ player games with another human still in,
   * a medium bot takes over the seat and the game goes on. A player who already went out just
   * leaves. In the lobby or after the game the seat is freed.
   */
  async leaveRoom(session: Session): Promise<Result<void>> {
    const { repos, mutex, notifier, timers } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');

      let updated: Room;
      if (session.role === 'spectator') {
        updated = { ...room, spectators: room.spectators.filter((s) => s.spectatorId !== session.id) };
      } else if (room.status === 'playing') {
        if (!room.members.some((m) => m.playerId === session.id)) return fail('NOT_IN_ROOM', 'You are not seated here');
        timers.cancelGrace(room.id, session.id);
        const game = await repos.games.get(room.id);
        // Commits (and broadcasts) the forfeit or the bot takeover; `none` if already out.
        const departed = game
          ? await departSeat(this.deps.committer, { room, game, playerId: session.id, voluntary: true })
          : null;
        if (departed && !departed.ok) return departed;
        const current = departed?.value.room ?? room;
        // A player who was already out keeps the seat (the engine still lists them), marked as left.
        const members = current.members.map((m) =>
          m.playerId === session.id && !m.leftGame ? { ...m, connected: false, leftGame: true, graceDeadline: null } : m,
        );
        updated = { ...current, members, hostId: nextHost(current.hostId, session.id, members) };
      } else {
        const members = room.members.filter((m) => m.playerId !== session.id);
        updated = { ...room, members, hostId: nextHost(room.hostId, session.id, members) };
      }
      await repos.sessions.delete(session.token);

      // A room always contains at least one human: with only bots left it is deleted.
      if (!hasHuman(updated.members)) {
        await repos.atomic.deleteRoomAndGame(room.id);
        this.deps.timers.cancelRoom(room.id);
        this.deps.votes?.cancel(room.id);
      } else {
        await repos.rooms.save(updated);
      }
      notifier.roomState(updated);
      if (hasHuman(updated.members)) await this.deps.votes?.reconcile(updated);
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
      const seat = session.role === 'player' ? room.members.find((m) => m.playerId === session.id) : null;
      if (session.role === 'player' && (!seat || seat.isBot || seat.leftGame)) {
        // The seat is no longer theirs (they left, or a bot took over after their grace expired).
        await repos.sessions.delete(token);
        return fail('INVALID_SESSION', 'You left this game');
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
        this.sendRatingStatus(updated, game, session);
      }
      // AFK was cleared: the bot stops playing for this player.
      const current = extendedGame ?? game;
      if (session.role === 'player' && current && room.status === 'playing') {
        this.deps.committer.announce(updated, current, null);
      }
      return ok(session);
    });
  }

  private sendRatingStatus(room: Room, game: StoredGame, viewer: Session): void {
    const status = this.deps.ratingStatus?.(room, game) ?? null;
    if (status) this.deps.notifier.gameRatingsTo(viewer, status);
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
      await this.deps.votes?.reconcile(updated); // an offline voter no longer blocks the vote
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
      if (isTeamGame(room.config) && room.members.length !== TEAM_GAME_PLAYERS) {
        return fail('TEAMS_NEED_FOUR', `A team game starts with all ${TEAM_GAME_PLAYERS} seats filled`);
      }

      const dealt = dealGame(room, this.deps.seedSource(), this.deps.now());
      if (!dealt.ok) return dealt;
      return ok(await this.deps.committer.start(dealt.value.room, dealt.value.game));
    });
  }

  /** Host only, lobby only, 4-seat rooms only: turns 2v2 team mode on or off. */
  async setTeams(session: Session, teams: boolean): Promise<Result<void>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) return fail('NOT_HOST', 'Only the host can change teams');
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'Teams can only be changed in the lobby');
      if (teams && room.maxPlayers !== TEAM_GAME_PLAYERS) {
        return fail('TEAMS_NEED_FOUR', `Team mode needs a ${TEAM_GAME_PLAYERS}-seat room`);
      }
      if (isTeamGame(room.config) === teams) {
        notifier.roomState(room); // idempotent
        return ok(undefined);
      }
      const { teams: _old, ...rest } = room.config;
      const updated: Room = { ...room, config: teams ? { ...rest, teams: true } : rest };
      await repos.rooms.save(updated);
      notifier.roomState(updated);
      return ok(undefined);
    });
  }

  /**
   * Host only, lobby only: swaps two members' seats (any members, bots included). Seats are the
   * member order, and in team mode the team follows the seat (0+2 vs 1+3), so this is how the host
   * arranges the teams (also after a leave or a rematch shifted the seats).
   */
  async swapSeats(session: Session, a: string, b: string): Promise<Result<void>> {
    const { repos, mutex, notifier } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      if (session.role !== 'player' || room.hostId !== session.id) return fail('NOT_HOST', 'Only the host can move seats');
      if (room.status !== 'lobby') return fail('GAME_IN_PROGRESS', 'Seats can only be changed in the lobby');
      const ia = room.members.findIndex((m) => m.playerId === a);
      const ib = room.members.findIndex((m) => m.playerId === b);
      if (ia < 0 || ib < 0 || ia === ib) return fail('NOT_IN_ROOM', 'Both players must be seated in this room');
      const members = room.members.slice();
      [members[ia], members[ib]] = [members[ib]!, members[ia]!];
      const updated: Room = { ...room, members };
      await repos.rooms.save(updated);
      notifier.roomState(updated);
      return ok(undefined);
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
      // Seats whose human left the game are freed (the host can add bots again).
      const members = room.members
        .filter((m) => !m.leftGame)
        .map((m) => ({ ...m, afk: false, consecutiveTimeouts: 0, graceDeadline: null }));
      const updated: Room = { ...room, status: 'lobby', members, hostId: nextHost(room.hostId, '', members) };
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
