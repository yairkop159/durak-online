import { getLegalMoves, moveKey, type GameState } from '@durak/game-engine';
import { sameCard, type Card, type ClientMove } from '@durak/shared';
import { explainTap, isGoalCard, lesson, pickedAll, type Reason, type TutorialGameId } from './lessons';
import { ME, actorOf, greedyMove, mustApply } from './setup';

/**
 * One lesson as an explicit state machine (pure: the same events always give the same states).
 * - `playing`: waiting for my goal move (or, in `win` / `free` games, for any move).
 * - `wrong`: a move or tap missed the goal; nothing was applied. `dismiss` → `playing`, same position.
 * - `opponent`: the goal was met; the opponents answer (`opponentStep`, one move each) until it is my
 *   turn again, the bout ends or the game ends → `success`.
 * - `success` / `failed` (the endgame lesson: I ended up the durak). `retry` rebuilds the lesson.
 */
export type TutorialPhase = 'playing' | 'wrong' | 'opponent' | 'success' | 'failed';

export interface TutorialState {
  readonly id: TutorialGameId;
  /** Counts retries (part of the table's game id, so a retry is a new game for the animations). */
  readonly attempt: number;
  readonly seed: number;
  readonly phase: TutorialPhase;
  readonly game: GameState;
  /** +1 per applied move. */
  readonly version: number;
  /** Cards tapped so far in a `pick` lesson. */
  readonly picked: readonly Card[];
  readonly reason: Reason | null;
  /** The bout in which the goal was met (`opponent` stops when it ends). */
  readonly goalBout: number;
}

export type TutorialEvent =
  | { readonly type: 'move'; readonly move: ClientMove }
  /** A hand tap the table can't turn into a move (`playable` false), or any tap in a `pick` lesson. */
  | { readonly type: 'tap'; readonly card: Card; readonly playable: boolean }
  | { readonly type: 'opponentStep' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'retry' };

export function startLesson(id: TutorialGameId, seed = 1, attempt = 0): TutorialState {
  return { id, attempt, seed, phase: 'playing', game: lesson(id).build(seed), version: 0, picked: [], reason: null, goalBout: 0 };
}


/** Whether the reducer takes this tap (the table should not handle it itself). */
export function takesTap(state: TutorialState, playable: boolean): boolean {
  if (state.phase !== 'playing') return false;
  const goal = lesson(state.id).goal;
  if (goal.kind === 'pick') return true;
  // Free practice: a dimmed tap just shakes, like online.
  return !playable && goal.kind !== 'free';
}

/** The opponent whose move is due (the driver paces it), or null. */
export function pendingOpponent(state: TutorialState): string | null {
  const goal = lesson(state.id).goal;
  const free = goal.kind === 'win' || goal.kind === 'free';
  if (state.phase !== 'opponent' && !(free && state.phase === 'playing')) return null;
  const actor = actorOf(state.game);
  return actor !== null && actor !== ME ? actor : null;
}

/** Leaves `opponent` once my turn has come back, the bout has ended or the game is over. */
function settle(state: TutorialState): TutorialState {
  const goal = lesson(state.id).goal;
  const g = state.game;
  if (g.phase.kind === 'finished' && (goal.kind === 'win' || goal.kind === 'free')) {
    const lost = g.phase.durak === ME;
    return { ...state, phase: lost && goal.kind === 'win' ? 'failed' : 'success', reason: lost && goal.kind === 'win' ? { kind: 'durak' } : null };
  }
  if (state.phase !== 'opponent') return state;
  const actor = actorOf(g);
  const done = g.phase.kind === 'finished' || g.boutNumber !== state.goalBout || actor === null || actor === ME;
  return done ? { ...state, phase: 'success' } : state;
}

function applied(state: TutorialState, game: GameState): TutorialState {
  return { ...state, game, version: state.version + 1 };
}

export function tutorialReducer(state: TutorialState, event: TutorialEvent): TutorialState {
  const def = lesson(state.id);
  const goal = def.goal;
  switch (event.type) {
    case 'retry':
      return startLesson(state.id, state.seed, state.attempt + 1);

    case 'dismiss':
      return state.phase === 'wrong' ? { ...state, phase: 'playing', reason: null } : state;

    case 'tap': {
      if (!takesTap(state, event.playable)) return state;
      if (goal.kind === 'pick') {
        if (state.picked.some((c) => sameCard(c, event.card))) return state;
        if (!isGoalCard(goal, event.card)) return { ...state, phase: 'wrong', reason: { kind: 'notTrump', card: event.card } };
        const picked = [...state.picked, event.card];
        return { ...state, picked, phase: pickedAll(goal, picked) ? 'success' : 'playing' };
      }
      return { ...state, phase: 'wrong', reason: explainTap(state.game, event.card) };
    }

    case 'move': {
      if (state.phase !== 'playing' || goal.kind === 'pick') return state;
      const full = { ...event.move, playerId: ME };
      // Only legal moves reach the engine (the table offers nothing else).
      const k = moveKey(event.move);
      if (!getLegalMoves(state.game, ME).some((m) => moveKey(m) === k)) return state;
      if (goal.kind === 'move' && !goal.accepts(event.move, state.game)) {
        return { ...state, phase: 'wrong', reason: goal.wrong(event.move, state.game) };
      }
      const next = applied(state, mustApply(state.game, full));
      if (goal.kind !== 'move') return settle(next);
      if (def.after === 'none') return { ...next, phase: 'success' };
      return settle({ ...next, phase: 'opponent', goalBout: state.game.boutNumber });
    }

    case 'opponentStep': {
      const actor = pendingOpponent(state);
      if (actor === null) return state;
      const m = greedyMove(state.game, actor);
      if (!m) return state;
      return settle(applied(state, mustApply(state.game, m)));
    }
  }
}
