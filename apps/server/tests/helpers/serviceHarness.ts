import type { GameRatingsPayload, ReactionPayload, RestartVoteEndedPayload } from '@durak/shared';
import { InProcessRunner } from '../../src/bot/InProcessRunner.js';
import type { BotPolicies, BotRunner } from '../../src/bot/job.js';
import type { Room, Session, StoredGame } from '../../src/domain/types.js';
import { BotDriver } from '../../src/services/BotDriver.js';
import { GameCommitter } from '../../src/services/GameCommitter.js';
import type { Repositories } from '../../src/repositories/interfaces.js';
import { createInMemoryRepositories } from '../../src/repositories/inMemory/index.js';
import { GameService } from '../../src/services/GameService.js';
import { KeyedMutex } from '../../src/services/KeyedMutex.js';
import type { RoomNotifier } from '../../src/services/ports.js';
import { ReactionService, type ReactionSettings } from '../../src/services/ReactionService.js';
import { DEFAULT_RESTART_VOTE_SETTINGS, RestartVoteService } from '../../src/services/RestartVoteService.js';
import { RoomService } from '../../src/services/RoomService.js';
import { DEFAULT_TIMER_SETTINGS, TurnTimerService, type TimerSettings } from '../../src/services/TurnTimerService.js';
import { GameResultRecorder } from '../../src/ratings/GameResultRecorder.js';
import type { ResultStore } from '../../src/ratings/ports.js';
import { RatingsPublisher } from '../../src/ratings/RatingsPublisher.js';
import { ResultQueue } from '../../src/ratings/ResultQueue.js';
import { FakeTime } from './fakeTime.js';

export interface NotifierEvent {
  readonly kind: 'room' | 'game' | 'over' | 'gameTo' | 'voteEnded' | 'reaction' | 'ratings' | 'ratingsTo';
  readonly ratings?: GameRatingsPayload;
  readonly ended?: Omit<RestartVoteEndedPayload, 'roomId'>;
  readonly reaction?: Omit<ReactionPayload, 'roomId'>;
  readonly version?: number;
  readonly to?: string;
  readonly room: Room;
  readonly game?: StoredGame;
}

export class RecordingNotifier implements RoomNotifier {
  readonly events: NotifierEvent[] = [];
  roomState(room: Room): void {
    this.events.push({ kind: 'room', room });
  }
  gameState(room: Room, game: StoredGame): void {
    this.events.push({ kind: 'game', version: game.version, room, game });
  }
  gameOver(room: Room, game: StoredGame): void {
    this.events.push({ kind: 'over', room, game });
  }
  restartVoteEnded(room: Room, ended: Omit<RestartVoteEndedPayload, 'roomId'>): void {
    this.events.push({ kind: 'voteEnded', room, ended });
  }
  reaction(room: Room, reaction: Omit<ReactionPayload, 'roomId'>): void {
    this.events.push({ kind: 'reaction', room, reaction });
  }
  sendGameStateTo(room: Room, game: StoredGame, viewer: Session): void {
    this.events.push({ kind: 'gameTo', version: game.version, to: viewer.id, room, game });
  }
  gameRatings(room: Room, payload: GameRatingsPayload): void {
    this.events.push({ kind: 'ratings', room, ratings: payload });
  }
  gameRatingsTo(viewer: Session, payload: GameRatingsPayload): void {
    this.events.push({ kind: 'ratingsTo', to: viewer.id, room: { id: payload.roomId } as Room, ratings: payload });
  }
  of(kind: NotifierEvent['kind']): NotifierEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

/** Small, deterministic bot budgets for tests (the in-process runner runs them synchronously). */
export const TEST_BOT_POLICIES: BotPolicies = {
  easy: { kind: 'greedy', randomRate: 0.15 },
  medium: { kind: 'ismcts', budget: { iterations: 12 } },
  hard: { kind: 'ismcts', budget: { iterations: 20 } },
};

export interface ServiceHarnessOptions {
  repos?: Repositories;
  time?: FakeTime;
  settings?: Partial<TimerSettings>;
  seed?: number;
  /**
   * Bot driver options. `afkTakeover` defaults to FALSE here so the Phase 3c timer tests keep
   * observing raw timeout behaviour; bot tests turn it on.
   */
  bots?: { afkTakeover?: boolean; runner?: BotRunner; random?: () => number; policies?: BotPolicies };
  /** Bot reactions are off by default here (chance 0), so existing tests see no extra timers. */
  reactions?: { random?: () => number; settings?: Partial<ReactionSettings> };
  /** Match history (Phase 10): when given, finished games are recorded through a ResultQueue. */
  results?: ResultStore;
  /** Whether Postgres counts as connected for the rating status (default: true). */
  ratingsReady?: () => boolean;
}

/** Services wired exactly like buildServer, on in-memory repos and fake time, without sockets. */
export function setupServices(options: ServiceHarnessOptions = {}) {
  const time = options.time ?? new FakeTime();
  const repos = options.repos ?? createInMemoryRepositories(() => time.now());
  const mutex = new KeyedMutex();
  const notifier = new RecordingNotifier();
  const settings: TimerSettings = { ...DEFAULT_TIMER_SETTINGS, ...options.settings };
  const log = { error: () => undefined };
  const timers = new TurnTimerService({ repos, mutex, notifier, clock: time, scheduler: time, settings, log });
  let driver: BotDriver | null = null;
  const reactions = new ReactionService({
    repos,
    notifier,
    clock: time,
    scheduler: time,
    random: options.reactions?.random ?? (() => 0.5),
    settings: { botChance: 0, ...options.reactions?.settings },
  });
  const resultLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const publisher = new RatingsPublisher({ repos, mutex, notifier });
  const resultQueue = options.results
    ? new ResultQueue({
        store: options.results,
        clock: time,
        scheduler: time,
        log: resultLog,
        onRecorded: async (input, ratings) => {
          await publisher.publish(input, ratings);
        },
      })
    : null;
  const recorder = resultQueue
    ? new GameResultRecorder({ queue: resultQueue, clock: time, enabled: () => true, ready: options.ratingsReady ?? (() => true), notifier })
    : null;
  const committer = new GameCommitter({
    repos,
    notifier,
    timers,
    listeners: () => [...(driver ? [driver] : []), reactions, ...(recorder ? [recorder] : [])],
  });
  timers.attachCommitter(committer);
  const seed = options.seed ?? 42;
  const votes = new RestartVoteService({
    repos,
    mutex,
    notifier,
    clock: time,
    scheduler: time,
    settings: DEFAULT_RESTART_VOTE_SETTINGS,
    committer,
    seedSource: () => seed,
    log,
    ...(recorder ? { onRestarted: (room: Room, game: StoredGame) => recorder.recordEnded(room, game) } : {}),
  });
  const rooms = new RoomService({
    repos,
    mutex,
    notifier,
    seedSource: () => seed,
    now: () => time.now(),
    timers,
    committer,
    votes,
    ...(recorder ? { ratingStatus: (room: Room, game: StoredGame) => recorder.statusFor(room, game) } : {}),
  });
  const games = new GameService({ repos, mutex, notifier, committer });
  const runner = options.bots?.runner ?? new InProcessRunner({ recordJobs: true });
  let nextSeed = 1;
  const bots = new BotDriver({
    runner,
    moves: games,
    clock: time,
    scheduler: time,
    seedSource: () => nextSeed++,
    policies: options.bots?.policies ?? TEST_BOT_POLICIES,
    random: options.bots?.random ?? (() => 0.5),
    afkTakeover: options.bots?.afkTakeover ?? false,
    log,
  });
  driver = bots;
  return { repos, rooms, games, timers, votes, notifier, time, settings, bots, runner, committer, mutex, reactions, recorder, resultQueue, publisher };
}

export const noBind = (): void => undefined;

export async function unwrap<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }>,
): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
