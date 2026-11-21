import { getLegalMoves } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import type { TutorialGameId } from '../src/tutorial/lessons';
import { pendingOpponent, startLesson, tutorialReducer, type TutorialEvent, type TutorialState } from '../src/tutorial/machine';
import { ME, card } from '../src/tutorial/setup';

export const mv = (move: ClientMove): TutorialEvent => ({ type: 'move', move });
export const tap = (code: string, playable: boolean): TutorialEvent => ({ type: 'tap', card: card(code), playable });

/** Each scripted lesson's solution: the goal, done right the first time. */
export const SOLUTIONS: Record<Exclude<TutorialGameId, 'durak' | 'practice'>, TutorialEvent[]> = {
  trump: [tap('7H', true), tap('KH', true)],
  attack: [mv({ type: 'attack', card: card('6S') })],
  'defend-suit': [mv({ type: 'defend', attackIndex: 0, card: card('10C') })],
  'defend-trump': [mv({ type: 'defend', attackIndex: 0, card: card('8H') })],
  take: [mv({ type: 'take' })],
  'throw-in': [mv({ type: 'attack', card: card('7C') })],
  'bout-end': [mv({ type: 'pass' })],
  transfer: [mv({ type: 'transfer', card: card('7D') })],
  teams: [mv({ type: 'attack', card: card('9D') })],
};

/** Lets the opponents answer until nobody is due (as the driver does), calling `onStep` per move. */
export function drain(state: TutorialState, onStep: (prev: TutorialState, next: TutorialState) => void = () => {}): TutorialState {
  for (let i = 0; i < 400 && pendingOpponent(state) !== null; i++) {
    const next = tutorialReducer(state, { type: 'opponentStep' });
    onStep(state, next);
    state = next;
  }
  return state;
}

/** The shortest winning line for the endgame lesson (my moves; the bot answers with GreedyBot). */
export function winningLine(state: TutorialState): TutorialEvent[] | null {
  if (state.phase === 'success') return [];
  if (state.phase !== 'playing') return null;
  let best: TutorialEvent[] | null = null;
  for (const m of getLegalMoves(state.game, ME)) {
    const { playerId: _, ...move } = m;
    const event = mv(move as ClientMove);
    const rest = winningLine(drain(tutorialReducer(state, event)));
    if (rest && (best === null || rest.length + 1 < best.length)) best = [event, ...rest];
  }
  return best;
}

/** Every basics/advanced lesson's solution line (the endgame's found by search). */
export function solutionOf(id: Exclude<TutorialGameId, 'practice'>): TutorialEvent[] {
  if (id === 'durak') {
    const line = winningLine(startLesson('durak'));
    if (!line) throw new Error('the endgame lesson has no winning line');
    return line;
  }
  return SOLUTIONS[id];
}
