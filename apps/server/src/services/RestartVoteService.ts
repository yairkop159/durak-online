import { abandon } from '@durak/game-engine';
import type { RestartVoteOutcome } from '@durak/shared';
import { fail, ok, type Result } from '../domain/result.js';
import type { RestartVote, Room, Session, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import { dealGame } from './dealing.js';
import type { GameCommitter } from './GameCommitter.js';
import type { KeyedMutex } from './KeyedMutex.js';
import type { RoomNotifier } from './ports.js';
import { newShortId, type SeedSource } from './random.js';
import { pruneCooldowns, settleVote, votersFor } from './restartVote.js';
import type { Clock, Scheduler, TimerHandle } from './scheduling.js';

export interface RestartVoteSettings {
  /** How long voters have to answer. */
  readonly restartVoteMs: number;
  /** After a vote that did not pass, its proposer must wait this long to propose again. */
  readonly restartCooldownMs: number;
}

export const DEFAULT_RESTART_VOTE_SETTINGS: RestartVoteSettings = {
  restartVoteMs: 30_000,
  restartCooldownMs: 60_000,
};

export interface RestartVoteDeps {
  readonly repos: Repositories;
  readonly mutex: KeyedMutex;
  readonly notifier: RoomNotifier;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly settings: RestartVoteSettings;
  readonly committer: GameCommitter;
  readonly seedSource: SeedSource;
  readonly log: { error(obj: object, msg: string): void };
}

/**
 * The "new game" vote. Any seated human proposes; the other connected, non-AFK humans must all
 * accept (bots and absent humans never block). Unanimous -> the running game ends with
 * `endReason: 'restarted'` (game:over, not rated) and a new game is dealt at once with the same
 * seats and config. A decline, the deadline, or the proposer leaving ends it. One vote per room.
 * Every mutation runs inside the room lock; the vote lives in the stored room (survives restarts).
 */
export class RestartVoteService {
  private readonly timers = new Map<string, TimerHandle>();

  constructor(private readonly deps: RestartVoteDeps) {}

  async propose(session: Session): Promise<Result<void>> {
    const { repos, mutex, clock, settings } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      const member = room.members.find((m) => m.playerId === session.id);
      if (session.role !== 'player' || !member || member.isBot || member.leftGame) {
        return fail('NOT_IN_ROOM', 'Only seated players can propose a new game');
      }
      const game = await repos.games.get(room.id);
      if (room.status !== 'playing' || !game || game.state.phase.kind === 'finished') {
        return fail('GAME_NOT_STARTED', 'No game is running');
      }
      if (room.restartVote) return fail('VOTE_IN_PROGRESS', 'A vote is already open');
      const now = clock.now();
      if ((room.restartCooldowns[session.id] ?? 0) > now) return fail('VOTE_COOLDOWN', 'You proposed too recently');

      const vote: RestartVote = {
        voteId: newShortId(),
        proposerId: session.id,
        expiresAt: now + settings.restartVoteMs,
        voters: votersFor(room, session.id),
        accepted: [],
      };
      this.arm(room.id, vote);
      await this.apply({ ...room, restartCooldowns: pruneCooldowns(room.restartCooldowns, now) }, vote, game);
      return ok(undefined);
    });
  }

  async respond(session: Session, voteId: string, accept: boolean): Promise<Result<void>> {
    const { repos, mutex } = this.deps;
    return mutex.runExclusive(session.roomId, async () => {
      const room = await repos.rooms.get(session.roomId);
      if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
      const vote = room.restartVote;
      if (
        session.role !== 'player' ||
        !vote ||
        vote.voteId !== voteId ||
        !vote.voters.includes(session.id) ||
        vote.accepted.includes(session.id)
      ) {
        return fail('NO_ACTIVE_VOTE', 'There is no vote for you to answer');
      }
      if (!accept) {
        await this.end(room, vote, 'declined', session.id);
        return ok(undefined);
      }
      await this.apply(room, { ...vote, accepted: [...vote.accepted, session.id] }, null);
      return ok(undefined);
    });
  }

  /**
   * Must be called inside the room lock after a room change that can affect the vote (a voter
   * disconnected or left, the proposer left). `room` is the room as just saved.
   */
  async reconcile(room: Room): Promise<void> {
    const vote = room.restartVote;
    if (!vote) return;
    const settled = settleVote(room, vote);
    if (settled.kind === 'open' && settled.vote.voters.length === vote.voters.length) return;
    await this.apply(room, vote, null);
  }

  async handleExpiry(roomId: string, voteId: string): Promise<void> {
    const { repos, mutex } = this.deps;
    await mutex.runExclusive(roomId, async () => {
      this.timers.delete(roomId);
      const room = await repos.rooms.get(roomId);
      const vote = room?.restartVote;
      if (!room || !vote || vote.voteId !== voteId) return; // ended already
      await this.end(room, vote, 'expired', null);
    });
  }

  /** Startup: re-arms the deadline of every persisted vote (past deadlines fire at once). */
  async rearmAll(): Promise<number> {
    let armed = 0;
    for await (const roomId of this.deps.repos.rooms.scanIds()) {
      const room = await this.deps.repos.rooms.get(roomId);
      if (room?.restartVote) {
        this.arm(roomId, room.restartVote);
        armed++;
      }
    }
    return armed;
  }

  cancel(roomId: string): void {
    const handle = this.timers.get(roomId);
    if (handle) this.deps.scheduler.cancel(handle);
    this.timers.delete(roomId);
  }

  dispose(): void {
    for (const handle of this.timers.values()) this.deps.scheduler.cancel(handle);
    this.timers.clear();
  }

  /** Diagnostics for tests. */
  get armedCount(): number {
    return this.timers.size;
  }

  // ------------------------------------------------------------------ internals (inside the lock)

  private arm(roomId: string, vote: RestartVote): void {
    this.cancel(roomId);
    this.timers.set(roomId, this.deps.scheduler.schedule(vote.expiresAt, () => this.handleExpiry(roomId, vote.voteId)));
  }

  /** Settles `vote` against `room` and stores / ends / passes it. */
  private async apply(room: Room, vote: RestartVote, game: StoredGame | null): Promise<void> {
    const settled = settleVote(room, vote);
    if (settled.kind === 'cancelled') {
      await this.end(room, vote, 'cancelled', null);
    } else if (settled.kind === 'passed') {
      await this.pass(room, settled.vote, game ?? (await this.deps.repos.games.get(room.id)));
    } else {
      const updated: Room = { ...room, restartVote: settled.vote };
      await this.deps.repos.rooms.save(updated);
      this.deps.notifier.roomState(updated);
    }
  }

  private async end(room: Room, vote: RestartVote, outcome: RestartVoteOutcome, by: string | null): Promise<void> {
    const now = this.deps.clock.now();
    const updated: Room = {
      ...room,
      restartVote: null,
      restartCooldowns: { ...pruneCooldowns(room.restartCooldowns, now), [vote.proposerId]: now + this.deps.settings.restartCooldownMs },
    };
    this.cancel(room.id);
    await this.deps.repos.rooms.save(updated);
    this.deps.notifier.roomState(updated);
    this.deps.notifier.restartVoteEnded(updated, { voteId: vote.voteId, proposerId: vote.proposerId, outcome, by });
  }

  /**
   * Ends the running game as 'restarted' and deals the new one. The old game is reported with
   * game:over (no durak, not rated) but not stored: the new version-0 game replaces it.
   */
  private async pass(room: Room, vote: RestartVote, game: StoredGame | null): Promise<void> {
    const { notifier, clock, committer, seedSource, log } = this.deps;
    const abandoned = game && game.state.phase.kind !== 'finished' ? abandon(game.state) : null;
    if (!game || !abandoned?.ok) {
      await this.end(room, vote, 'cancelled', null);
      return;
    }
    const cleared: Room = { ...room, restartVote: null, restartCooldowns: pruneCooldowns(room.restartCooldowns, clock.now()) };
    const dealt = dealGame(cleared, seedSource(), clock.now());
    if (!dealt.ok) {
      log.error({ roomId: room.id, error: dealt.error }, 'restart deal failed');
      await this.end(room, vote, 'cancelled', null);
      return;
    }
    this.cancel(room.id);
    notifier.gameOver(cleared, { ...game, state: abandoned.value, endReason: 'restarted', turnDeadline: null });
    await committer.start(dealt.value.room, dealt.value.game);
    notifier.restartVoteEnded(dealt.value.room, { voteId: vote.voteId, proposerId: vote.proposerId, outcome: 'passed', by: null });
  }
}
