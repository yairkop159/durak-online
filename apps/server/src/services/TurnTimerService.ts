import { getAwaitedPlayers, resign, type GameState } from '@durak/game-engine';
import type { Room, RoomMember, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier } from './ports.js';
import type { Clock, Scheduler, TimerHandle } from './scheduling.js';
import { stepOnTimeout } from './timeoutPolicy.js';

export interface TimerSettings {
  readonly turnTimeoutMs: number;
  /** Used instead of turnTimeoutMs when every awaited player is AFK. */
  readonly afkTimeoutMs: number;
  readonly reconnectGraceMs: number;
}

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
  turnTimeoutMs: 30_000,
  afkTimeoutMs: 5_000,
  reconnectGraceMs: 60_000,
};

/** Consecutive timeouts after which a player is flagged AFK. */
export const AFK_AFTER_TIMEOUTS = 2;

export interface TurnTimerDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly settings: TimerSettings;
  readonly log: { error(obj: object, msg: string): void };
}

export function isOut(state: GameState, playerId: string): boolean {
  return state.finishOrder.includes(playerId);
}

/**
 * Owns every server deadline: one turn timer per game and one grace timer per offline player.
 * Deadlines live in the stored records (so they survive restarts); this class only keeps the
 * in-process timer handles. Expiry handlers run inside the room lock and re-validate everything,
 * so a stale or duplicate timer is always a no-op.
 */
export class TurnTimerService {
  private readonly turnTimers = new Map<string, TimerHandle>();
  private readonly graceTimers = new Map<string, TimerHandle>();

  constructor(private readonly deps: TurnTimerDeps) {}

  /** Deadline for the current turn, or null when the game is over. */
  deadlineFor(room: Room, state: GameState): number | null {
    if (state.phase.kind === 'finished') return null;
    const awaited = getAwaitedPlayers(state);
    const allAfk = awaited.length > 0 && awaited.every((id) => room.members.find((m) => m.playerId === id)?.afk);
    const { afkTimeoutMs, turnTimeoutMs } = this.deps.settings;
    return this.deps.clock.now() + (allAfk ? afkTimeoutMs : turnTimeoutMs);
  }

  /** Deadline for a player who just went offline. */
  newGraceDeadline(): number {
    return this.deps.clock.now() + this.deps.settings.reconnectGraceMs;
  }

  // ---------------------------------------------------------------- scheduling (no lock needed)

  armTurn(game: StoredGame): void {
    this.cancelTurn(game.roomId);
    if (game.turnDeadline === null) return;
    const { roomId, version } = game;
    this.turnTimers.set(
      roomId,
      this.deps.scheduler.schedule(game.turnDeadline, () => this.handleTurnExpiry(roomId, version)),
    );
  }

  cancelTurn(roomId: string): void {
    const handle = this.turnTimers.get(roomId);
    if (handle) this.deps.scheduler.cancel(handle);
    this.turnTimers.delete(roomId);
  }

  armGrace(roomId: string, playerId: string, deadline: number): void {
    this.cancelGrace(roomId, playerId);
    this.graceTimers.set(
      graceKey(roomId, playerId),
      this.deps.scheduler.schedule(deadline, () => this.handleGraceExpiry(roomId, playerId, deadline)),
    );
  }

  cancelGrace(roomId: string, playerId: string): void {
    const key = graceKey(roomId, playerId);
    const handle = this.graceTimers.get(key);
    if (handle) this.deps.scheduler.cancel(handle);
    this.graceTimers.delete(key);
  }

  /** Cancels the turn timer and every grace timer of a room (game over / room deleted). */
  cancelRoom(roomId: string): void {
    this.cancelTurn(roomId);
    for (const key of [...this.graceTimers.keys()]) {
      if (key.startsWith(`${roomId}\u0000`)) {
        this.deps.scheduler.cancel(this.graceTimers.get(key)!);
        this.graceTimers.delete(key);
      }
    }
  }

  /** Cancels everything (server shutdown). */
  dispose(): void {
    for (const handle of [...this.turnTimers.values(), ...this.graceTimers.values()]) {
      this.deps.scheduler.cancel(handle);
    }
    this.turnTimers.clear();
    this.graceTimers.clear();
  }

  /** Diagnostics for tests. */
  get armedCount(): { turn: number; grace: number } {
    return { turn: this.turnTimers.size, grace: this.graceTimers.size };
  }

  // ---------------------------------------------------------------- expiry handlers (take the lock)

  async handleTurnExpiry(roomId: string, version: number): Promise<void> {
    const { repos, mutex, notifier, clock, log } = this.deps;
    await mutex.runExclusive(roomId, async () => {
      const room = await repos.rooms.get(roomId);
      const game = await repos.games.get(roomId);
      if (!room || !game || game.version !== version) return; // stale timer
      if (game.state.phase.kind === 'finished' || game.turnDeadline === null) return;
      if (clock.now() < game.turnDeadline) {
        this.armTurn(game); // woke up early (deadline was extended): re-arm
        return;
      }

      const step = stepOnTimeout(game.state, game.timeoutStreak);
      if (!step.ok) {
        log.error({ roomId, error: step.error }, 'timeout step failed');
        return;
      }
      const { state, timedOut, streak, endReason } = step.value;
      const finished = state.phase.kind === 'finished';

      let membersChanged = false;
      const members = room.members.map((m): RoomMember => {
        if (!timedOut.includes(m.playerId)) return m;
        membersChanged = true;
        const consecutiveTimeouts = m.consecutiveTimeouts + 1;
        return { ...m, consecutiveTimeouts, afk: m.afk || consecutiveTimeouts >= AFK_AFTER_TIMEOUTS };
      });
      const updatedRoom: Room = { ...room, members, status: finished ? 'finished' : room.status };
      const next: StoredGame = {
        ...game,
        version: game.version + 1,
        state,
        timeoutStreak: streak,
        endReason,
        turnDeadline: this.deadlineFor(updatedRoom, state),
      };
      await repos.atomic.saveRoomAndGame(updatedRoom, next);

      if (membersChanged || finished) notifier.roomState(updatedRoom);
      notifier.gameState(updatedRoom, next);
      if (finished) {
        notifier.gameOver(updatedRoom, next);
        this.cancelRoom(roomId);
      } else {
        this.armTurn(next);
      }
    });
  }

  async handleGraceExpiry(roomId: string, playerId: string, deadline: number): Promise<void> {
    const { repos, mutex, notifier } = this.deps;
    await mutex.runExclusive(roomId, async () => {
      this.graceTimers.delete(graceKey(roomId, playerId));
      const room = await repos.rooms.get(roomId);
      const member = room?.members.find((m) => m.playerId === playerId);
      if (!room || !member || member.connected || member.graceDeadline !== deadline) return; // stale

      const clearGrace = (r: Room): Room => ({
        ...r,
        members: r.members.map((m) => (m.playerId === playerId ? { ...m, graceDeadline: null } : m)),
      });
      const game = await repos.games.get(roomId);
      if (room.status !== 'playing' || !game || game.state.phase.kind === 'finished' || isOut(game.state, playerId)) {
        await repos.rooms.save(clearGrace(room)); // nothing to forfeit
        return;
      }

      const resigned = resign(game.state, playerId);
      if (!resigned.ok) return;
      const updatedRoom: Room = { ...clearGrace(room), status: 'finished' };
      const next: StoredGame = {
        ...game,
        version: game.version + 1,
        state: resigned.value,
        turnDeadline: null,
        endReason: 'forfeit',
      };
      await repos.atomic.saveRoomAndGame(updatedRoom, next);
      notifier.roomState(updatedRoom);
      notifier.gameState(updatedRoom, next);
      notifier.gameOver(updatedRoom, next);
      this.cancelRoom(roomId);
    });
  }

  // ---------------------------------------------------------------- startup

  /**
   * Re-arms every persisted deadline after a restart (run after the ghost-connection reset).
   * Offline seated players without a grace get one — they are the ghosts of the old process.
   * Deadlines already in the past fire as soon as the scheduler runs.
   */
  async rearmAll(): Promise<{ games: number; graces: number }> {
    const { repos, mutex, clock, settings } = this.deps;
    let games = 0;
    let graces = 0;
    for await (const roomId of repos.rooms.scanIds()) {
      await mutex.runExclusive(roomId, async () => {
        const room = await repos.rooms.get(roomId);
        const game = await repos.games.get(roomId);
        if (!room || room.status !== 'playing' || !game || game.state.phase.kind === 'finished') return;

        let roomChanged = false;
        const members = room.members.map((m): RoomMember => {
          if (m.connected || m.graceDeadline !== null || isOut(game.state, m.playerId)) return m;
          roomChanged = true;
          return { ...m, graceDeadline: clock.now() + settings.reconnectGraceMs };
        });
        const updatedRoom: Room = { ...room, members };
        let updatedGame = game;
        if (game.turnDeadline === null) {
          updatedGame = { ...game, turnDeadline: this.deadlineFor(updatedRoom, game.state) };
        }
        if (roomChanged || updatedGame !== game) await repos.atomic.saveRoomAndGame(updatedRoom, updatedGame);

        this.armTurn(updatedGame);
        games++;
        for (const m of members) {
          if (m.graceDeadline !== null) {
            this.armGrace(roomId, m.playerId, m.graceDeadline);
            graces++;
          }
        }
      });
    }
    return { games, graces };
  }
}

function graceKey(roomId: string, playerId: string): string {
  return `${roomId}\u0000${playerId}`;
}
