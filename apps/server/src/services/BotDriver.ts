import { canonicalActor, getLegalMovesForView, initKnowledge, sanitizeStateForPlayer, type GameState } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import { AFK_TAKEOVER_DIFFICULTY, DEFAULT_BOT_POLICIES, type BotJob, type BotPolicies, type BotRunner } from '../bot/job.js';
import type { Room, RoomMember, StoredGame } from '../domain/types.js';
import type { AutomatedMoveSink } from './GameService.js';
import type { GameChangeListener } from './ports.js';
import type { Clock, Scheduler, TimerHandle } from './scheduling.js';

/** Human-like pacing (ms from the state change to the bot's move). */
export interface BotPacing {
  /** After an ordinary move: min + rand * spread. */
  readonly moveMinMs: number;
  readonly moveSpreadMs: number;
  /** After a bout resolution, so the client's resolution animation (≤ 1.2 s) finishes first. */
  readonly resolutionMinMs: number;
  readonly resolutionSpreadMs: number;
}

export const DEFAULT_BOT_PACING: BotPacing = {
  moveMinMs: 800,
  moveSpreadMs: 700,
  resolutionMinMs: 1300,
  resolutionSpreadMs: 500,
};

export interface BotDriverDeps {
  readonly runner: BotRunner;
  readonly moves: AutomatedMoveSink;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly policies?: BotPolicies;
  readonly pacing?: BotPacing;
  /** In [0, 1); server-side randomness for pacing (default Math.random). */
  readonly random?: () => number;
  /** Seed for each search (default: the server's crypto seed source). */
  readonly seedSource: () => number;
  /** Whether the bot plays for AFK humans (default true). */
  readonly afkTakeover?: boolean;
  readonly log: { error(obj: object, msg: string): void };
}

/**
 * One planned decision for one seat at one version.
 *   Thinking: job submitted, `move` undefined.   Ready: job resolved, apply timer armed.
 *   Applying: timer fired, applyAutomatedMove in progress.
 * An entry that is no longer in `entries` (or whose `abort` fired) is dead: every callback checks.
 */
interface Entry {
  readonly roomId: string;
  readonly playerId: string;
  /** A restart deals a new game at version 0 again: an entry belongs to one game. */
  readonly gameId: string;
  readonly version: number;
  readonly abort: AbortController;
  readonly applyAt: number;
  stage: 'thinking' | 'ready' | 'applying';
  timer: TimerHandle | null;
}

/** Diagnostics for tests. */
export interface BotDriverEvent {
  readonly kind: 'planned' | 'applied' | 'stale' | 'rejected' | 'cancelled';
  readonly roomId: string;
  readonly playerId: string;
  readonly version: number;
  readonly at: number;
}

/**
 * Plays bot seats (and AFK humans) in running games.
 *
 * `onGameChanged` is called inside the room lock after every committed change, start, resume and
 * startup re-arm. It plans only for the engine's canonical actor (the same turn order the IS-MCTS
 * search assumes), only if that seat is bot-controlled and has a legal move. The job is a snapshot
 * of that exact version (view + knowledge), built while the lock is held.
 *
 * The move is applied at max(change time + pacing delay, job completion) through the same
 * GameService path as a human move, with expectedVersion = the planned version. Any newer change
 * aborts older entries; a STALE_STATE apply is dropped silently, because the newer version has
 * already planned for itself.
 */
export class BotDriver implements GameChangeListener {
  private readonly entries = new Map<string, Entry>();
  private nextJobId = 1;
  private disposed = false;
  readonly events: BotDriverEvent[] = [];

  constructor(private readonly deps: BotDriverDeps) {}

  onGameChanged(room: Room, game: StoredGame, prev: GameState | null): void {
    if (this.disposed) return;
    if (room.status !== 'playing' || game.state.phase.kind === 'finished') {
      this.cancelRoom(room.id);
      return;
    }
    const actorIndex = canonicalActor(game.state);
    const actorId = actorIndex >= 0 ? game.state.players[actorIndex]!.id : null;
    const member = actorId === null ? undefined : room.members.find((m) => m.playerId === actorId);
    const wanted = member && this.isControlled(member) ? key(room.id, member.playerId) : null;

    // Abort everything in this room except an entry already planned for exactly this seat + version.
    for (const [k, entry] of this.entries) {
      if (entry.roomId !== room.id) continue;
      if (k === wanted && entry.version === game.version && entry.gameId === game.gameId) continue;
      this.drop(k, entry, 'cancelled');
    }
    if (!wanted || !member || this.entries.has(wanted)) return;
    this.plan(room, game, member, isResolution(prev, game.state));
  }

  cancelRoom(roomId: string): void {
    for (const [k, entry] of this.entries) if (entry.roomId === roomId) this.drop(k, entry, 'cancelled');
  }

  dispose(): void {
    this.disposed = true;
    for (const [k, entry] of this.entries) this.drop(k, entry, 'cancelled');
  }

  /** Diagnostics for tests. */
  get inFlight(): readonly { roomId: string; playerId: string; version: number; stage: Entry['stage'] }[] {
    return [...this.entries.values()].map((e) => ({ roomId: e.roomId, playerId: e.playerId, version: e.version, stage: e.stage }));
  }

  // ------------------------------------------------------------------ internals

  private isControlled(member: RoomMember): boolean {
    return member.isBot || (member.afk && (this.deps.afkTakeover ?? true));
  }

  private plan(room: Room, game: StoredGame, member: RoomMember, resolution: boolean): void {
    const { clock, runner } = this.deps;
    const playerId = member.playerId;
    const view = sanitizeStateForPlayer(game.state, playerId);
    if (getLegalMovesForView(view).length === 0) return;

    const policies = this.deps.policies ?? DEFAULT_BOT_POLICIES;
    const difficulty = member.isBot && member.botDifficulty ? member.botDifficulty : AFK_TAKEOVER_DIFFICULTY;
    const job: BotJob = {
      jobId: this.nextJobId++,
      view,
      knowledge: game.knowledge[playerId] ?? initKnowledge(view),
      options: { seed: this.deps.seedSource(), policy: policies[difficulty] },
    };

    const k = key(room.id, playerId);
    const entry: Entry = {
      roomId: room.id,
      playerId,
      gameId: game.gameId,
      version: game.version,
      abort: new AbortController(),
      applyAt: clock.now() + this.delay(resolution),
      stage: 'thinking',
      timer: null,
    };
    this.entries.set(k, entry);
    this.record('planned', entry);

    runner
      .run(job, entry.abort.signal)
      .then((move) => this.onDecided(k, entry, move))
      .catch((error: unknown) => {
        this.deps.log.error({ err: error, roomId: room.id }, 'bot decision failed');
        if (this.entries.get(k) === entry) this.entries.delete(k);
      });
  }

  private onDecided(k: string, entry: Entry, move: ClientMove | null): void {
    if (this.entries.get(k) !== entry || entry.abort.signal.aborted) return;
    if (!move) {
      this.entries.delete(k); // nothing to play; the turn timer remains the fallback
      return;
    }
    entry.stage = 'ready';
    const at = Math.max(entry.applyAt, this.deps.clock.now());
    entry.timer = this.deps.scheduler.schedule(at, () => this.apply(k, entry, move));
  }

  private async apply(k: string, entry: Entry, move: ClientMove): Promise<void> {
    entry.timer = null;
    if (this.entries.get(k) !== entry || entry.abort.signal.aborted) return;
    entry.stage = 'applying';
    const result = await this.deps.moves.applyAutomatedMove(entry.roomId, entry.playerId, move, entry.version);
    // On success the commit already replaced this entry (onGameChanged for the new version).
    if (this.entries.get(k) === entry) this.entries.delete(k);
    if (result.ok) {
      this.record('applied', entry);
    } else if (result.error.code === 'STALE_STATE') {
      this.record('stale', entry); // someone moved first; that version planned for itself
    } else {
      this.record('rejected', entry);
      this.deps.log.error({ roomId: entry.roomId, playerId: entry.playerId, error: result.error }, 'bot move rejected');
    }
  }

  private drop(k: string, entry: Entry, kind: BotDriverEvent['kind']): void {
    this.entries.delete(k);
    entry.abort.abort();
    if (entry.timer) this.deps.scheduler.cancel(entry.timer);
    entry.timer = null;
    // An applying entry is dropped by its own commit (the new version replans); `apply` records it.
    if (entry.stage !== 'applying') this.record(kind, entry);
  }

  private delay(resolution: boolean): number {
    const pacing = this.deps.pacing ?? DEFAULT_BOT_PACING;
    const r = Math.min(Math.max((this.deps.random ?? Math.random)(), 0), 1);
    return resolution
      ? pacing.resolutionMinMs + r * pacing.resolutionSpreadMs
      : pacing.moveMinMs + r * pacing.moveSpreadMs;
  }

  private record(kind: BotDriverEvent['kind'], entry: Entry): void {
    this.events.push({ kind, roomId: entry.roomId, playerId: entry.playerId, version: entry.version, at: this.deps.clock.now() });
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 5_000);
  }
}

function key(roomId: string, playerId: string): string {
  return `${roomId}\u0000${playerId}`;
}

/** The change that led here resolved a bout (new bout number, or the table was cleared). */
function isResolution(prev: GameState | null, next: GameState): boolean {
  if (!prev) return false;
  return prev.boutNumber !== next.boutNumber || (prev.table.length > 0 && next.table.length === 0);
}
