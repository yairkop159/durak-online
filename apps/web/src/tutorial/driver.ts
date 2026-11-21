import { sanitizeStateForPlayer } from '@durak/game-engine';
import type { GameOverPayload } from '@durak/shared';
import type { ClientGame } from '../net/store';
import { lesson, type TutorialGameId } from './lessons';
import { pendingOpponent, startLesson, tutorialReducer, type TutorialEvent, type TutorialState } from './machine';
import { OPPONENT_DELAY_AFTER_BOUT_MS, OPPONENT_DELAY_MS } from './pacing';
import { ME } from './setup';

/** Runs `fn` after `ms`; returns a cancel function. Injectable for tests. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export interface DriverOptions {
  readonly seed?: number;
  readonly schedule?: Schedule;
  readonly now?: () => number;
  /** The animation speed factor (settings), read when an opponent move is scheduled. */
  readonly speed?: () => number;
  /** Called once each time a lesson is completed (`success`). */
  readonly onSuccess?: (id: TutorialGameId) => void;
}

export interface TutorialSnapshot {
  readonly tutorial: TutorialState;
  /** The table's game, exactly like a `game:state` from the server: my sanitized view only. */
  readonly game: ClientGame;
  readonly gameOver: GameOverPayload | null;
}

export const TUTORIAL_ROOM = 'tutorial';

/**
 * The local "server" of a lesson: holds the full state (never shown), applies my moves through the
 * pure machine, and plays the opponents one paced move at a time. The table only sees my view.
 */
export class TutorialDriver {
  private snapshot: TutorialSnapshot;
  private readonly listeners = new Set<() => void>();
  private cancelTimer: (() => void) | null = null;
  private readonly schedule: Schedule;
  /** Opponent moves are only scheduled while the lesson is on screen (`start` / `stop`). */
  private active = false;

  constructor(
    id: TutorialGameId,
    private readonly options: DriverOptions = {},
  ) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.snapshot = this.snapshotOf(startLesson(id, options.seed ?? 1), null);
  }

  /** On screen: opponents may move (safe to call again after `stop`, e.g. React StrictMode). */
  start(): void {
    this.active = true;
    this.armOpponent(false);
  }

  /** Off screen: nothing is scheduled any more. */
  stop(): void {
    this.active = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  getSnapshot = (): TutorialSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly now = (): number => (this.options.now ?? Date.now)();

  dispatch(event: TutorialEvent): void {
    const prev = this.snapshot.tutorial;
    const next = tutorialReducer(prev, event);
    if (next === prev) return;
    // A retry (or a move I made) supersedes any opponent move that was waiting.
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.snapshot = this.snapshotOf(next, this.snapshot);
    if (next.phase === 'success' && prev.phase !== 'success') this.options.onSuccess?.(next.id);
    const resolved = next.game.boutNumber !== prev.game.boutNumber;
    this.armOpponent(resolved);
    for (const listener of [...this.listeners]) listener();
  }

  private armOpponent(afterResolution: boolean): void {
    if (!this.active || this.cancelTimer || pendingOpponent(this.snapshot.tutorial) === null) return;
    const speed = this.options.speed?.() ?? 1;
    const ms = (afterResolution ? OPPONENT_DELAY_AFTER_BOUT_MS : OPPONENT_DELAY_MS) * speed;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.dispatch({ type: 'opponentStep' });
    }, ms);
  }

  private snapshotOf(tutorial: TutorialState, prev: TutorialSnapshot | null): TutorialSnapshot {
    const gameId = `${tutorial.id}#${tutorial.attempt}`;
    const same = prev && prev.game.gameId === gameId && prev.game.version === tutorial.version;
    const game: ClientGame = same
      ? prev.game
      : {
          roomId: TUTORIAL_ROOM,
          gameId,
          version: tutorial.version,
          view: sanitizeStateForPlayer(tutorial.game, ME),
          turnDeadline: null,
          serverTime: 0,
          receivedAt: this.now(),
        };
    const phase = tutorial.game.phase;
    const gameOver: GameOverPayload | null =
      phase.kind !== 'finished'
        ? null
        : same && prev.gameOver
          ? prev.gameOver
          : {
              roomId: TUTORIAL_ROOM,
              durakId: phase.durak,
              finishOrder: tutorial.game.finishOrder,
              endReason: 'normal',
              botAssisted: [],
              forfeits: [],
              stats: {},
            };
    return { tutorial, game, gameOver };
  }
}

/** Seat names for a lesson (bots, so the table shows the bot pill). */
export function tutorialMembers(id: TutorialGameId, names: Readonly<Record<string, string>>, myName: string) {
  return lesson(id).players.map((playerId) => ({
    playerId,
    nickname: playerId === ME ? myName : (names[playerId] ?? playerId),
    connected: true,
    isBot: playerId !== ME,
    botDifficulty: playerId === ME ? null : ('easy' as const),
    afk: false,
    leftGame: false,
  }));
}
