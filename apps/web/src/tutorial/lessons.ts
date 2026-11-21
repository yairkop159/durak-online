import { createGame, type GameState } from '@durak/game-engine';
import { sameCard, type Card, type ClientMove, type Move } from '@durak/shared';
import { ME, buildGame, card, cards, deckFor, fastForward } from './setup';

/** The lessons, in order. Basics (1-8) unlock the free practice game; advanced (9-10) are optional. */
export const LESSON_IDS = [
  'trump',
  'attack',
  'defend-suit',
  'defend-trump',
  'take',
  'throw-in',
  'bout-end',
  'durak',
  'transfer',
  'teams',
] as const;
export type LessonId = (typeof LESSON_IDS)[number];
/** A lesson, or the free practice game after the basics. */
export type TutorialGameId = LessonId | 'practice';

export const BASICS: readonly LessonId[] = LESSON_IDS.slice(0, 8);
export const ADVANCED: readonly LessonId[] = LESSON_IDS.slice(8);
export const lessonGroup = (id: LessonId): 'basics' | 'advanced' => (BASICS.includes(id) ? 'basics' : 'advanced');

/** Why a move or a tap misses the goal (the text lives in he.ts, `tutorial.reasons`). */
export type Reason =
  | { readonly kind: 'notTrump'; readonly card: Card }
  | { readonly kind: 'lowerSameSuit'; readonly card: Card; readonly target: Card }
  | { readonly kind: 'otherSuit'; readonly card: Card; readonly target: Card }
  | { readonly kind: 'trumpNeedsHigherTrump'; readonly card: Card; readonly target: Card }
  | { readonly kind: 'rankNotOnTable'; readonly card: Card }
  | { readonly kind: 'tableLimit' }
  | { readonly kind: 'notNow' }
  /** Legal, but a trump spent where a plain card does the job. */
  | { readonly kind: 'saveTrump'; readonly card: Card }
  /** Take while a defense exists. */
  | { readonly kind: 'canBeat' }
  /** Pass while the lesson is about throwing in. */
  | { readonly kind: 'shouldThrowIn' }
  /** A throw-in while the lesson is about ending the bout. */
  | { readonly kind: 'shouldPass' }
  /** Defend or take while the lesson is about transferring. */
  | { readonly kind: 'shouldTransfer'; readonly card: Card }
  /** Ended up the durak (the endgame lesson). */
  | { readonly kind: 'durak' };

export type Goal =
  /** Tap every one of these hand cards (no move is made). */
  | { readonly kind: 'pick'; readonly cards: readonly Card[] }
  /** One move that `accepts`; any other legal move is explained by `wrong`. */
  | {
      readonly kind: 'move';
      readonly accepts: (move: ClientMove, state: GameState) => boolean;
      readonly wrong: (move: ClientMove, state: GameState) => Reason;
    }
  /** Play on until the game ends; the goal is not to be the durak. */
  | { readonly kind: 'win' }
  /** The free practice game: any result is fine. */
  | { readonly kind: 'free' };

export interface Lesson {
  readonly id: TutorialGameId;
  /** Builds the starting position, only through the engine (`setup.ts`). */
  readonly build: (seed: number) => GameState;
  readonly goal: Goal;
  /** The hand cards to highlight (the rest of the legal cards still work, unhighlighted). Absent = all legal. */
  readonly focus?: (state: GameState) => readonly Card[];
  readonly highlightTrump?: boolean;
  /**
   * After the goal move: `none` = success at once; `untilMyTurn` = the opponents answer (one paced
   * move at a time) until it is my turn again, the bout ends or the game ends.
   */
  readonly after: 'none' | 'untilMyTurn';
  /** Seat names (he.ts `tutorial.names`), by player id. */
  readonly players: readonly string[];
  /** Player ids of my partner (2v2). */
  readonly partner?: string;
}

const has = (list: readonly Card[], c: Card) => list.some((x) => sameCard(x, c));
const move = (playerId: string, m: ClientMove): Move => ({ ...m, playerId });
const isTrump = (state: GameState, c: Card) => c.suit === state.trumpCard.suit;
const uncovered = (state: GameState) => state.table.filter((p) => p.defense === null).map((p) => p.attack);

/** Lesson 1: tap your trumps. I hold 7♥ and K♥ (♥ is the trump). */
const TRUMP_HANDS = ['6S 9C 7H QD KH 10S', '8S 8C JD 9D AS QC'];

const LESSONS: Record<TutorialGameId, Lesson> = {
  trump: {
    id: 'trump',
    players: [ME, 'bot'],
    build: () => buildGame([ME, 'bot'], deckFor(TRUMP_HANDS, '9H'), { mode: 'podkidnoy' }),
    goal: { kind: 'pick', cards: cards('7H KH') },
    highlightTrump: true,
    after: 'none',
  },
  attack: {
    id: 'attack',
    players: [ME, 'bot'],
    build: () => buildGame([ME, 'bot'], deckFor(TRUMP_HANDS, '9H'), { mode: 'podkidnoy' }),
    goal: {
      kind: 'move',
      accepts: (m, s) => m.type === 'attack' && !isTrump(s, m.card),
      wrong: (m) => (m.type === 'attack' ? { kind: 'saveTrump', card: m.card } : { kind: 'notNow' }),
    },
    focus: (s) => s.players[0]!.hand.filter((c) => !isTrump(s, c)),
    after: 'untilMyTurn',
  },
  'defend-suit': {
    id: 'defend-suit',
    players: [ME, 'bot'],
    // The bot holds the lowest trump (6♥), so it attacks first: 8♣.
    build: () =>
      buildGame([ME, 'bot'], deckFor(['6C 10C 7S 9D JH QS', '6H 8C AS KD 7C 9S'], '8H'), { mode: 'podkidnoy' }, [
        move('bot', { type: 'attack', card: card('8C') }),
      ]),
    goal: {
      kind: 'move',
      accepts: (m, s) => m.type === 'defend' && !isTrump(s, m.card),
      wrong: (m) => (m.type === 'take' ? { kind: 'canBeat' } : m.type === 'defend' ? { kind: 'saveTrump', card: m.card } : { kind: 'notNow' }),
    },
    focus: () => cards('10C'),
    after: 'untilMyTurn',
  },
  'defend-trump': {
    id: 'defend-trump',
    players: [ME, 'bot'],
    build: () =>
      buildGame([ME, 'bot'], deckFor(['7D 10S 8H 9C QS JC', '6H AD KS 7C 9S 10C'], '9H'), { mode: 'podkidnoy' }, [
        move('bot', { type: 'attack', card: card('AD') }),
      ]),
    goal: {
      kind: 'move',
      accepts: (m, s) => m.type === 'defend' && isTrump(s, m.card),
      wrong: (m) => (m.type === 'take' ? { kind: 'canBeat' } : { kind: 'notNow' }),
    },
    focus: () => cards('8H'),
    after: 'untilMyTurn',
  },
  take: {
    id: 'take',
    players: [ME, 'bot'],
    // Nothing beats 10♠ (no higher spade, no trump): take. The bot then throws in its 10♦.
    build: () =>
      buildGame([ME, 'bot'], deckFor(['6S 9S 7C 8D JC QD', '6H 10S 10D KS 7H AC'], '9H'), { mode: 'podkidnoy' }, [
        move('bot', { type: 'attack', card: card('10S') }),
      ]),
    goal: { kind: 'move', accepts: (m) => m.type === 'take', wrong: () => ({ kind: 'notNow' }) },
    focus: () => [],
    after: 'untilMyTurn',
  },
  'throw-in': {
    id: 'throw-in',
    players: [ME, 'bot'],
    // I hold the lowest trump (8♥): I opened with 7♠ and the bot covered it with 9♠.
    build: () =>
      buildGame([ME, 'bot'], deckFor(['7S 7C 9D QS KC 8H', '9S AS 10D QD JH 6C'], '6H'), { mode: 'podkidnoy' }, [
        move(ME, { type: 'attack', card: card('7S') }),
        move('bot', { type: 'defend', attackIndex: 0, card: card('9S') }),
      ]),
    goal: {
      kind: 'move',
      accepts: (m) => m.type === 'attack',
      wrong: (m) => (m.type === 'pass' ? { kind: 'shouldThrowIn' } : { kind: 'notNow' }),
    },
    focus: () => cards('7C 9D'),
    after: 'untilMyTurn',
  },
  'bout-end': {
    id: 'bout-end',
    players: [ME, 'bot'],
    // I opened with 8♣, the bot covered it with 10♣. I could still add 8♦, but I am done.
    build: () =>
      buildGame([ME, 'bot'], deckFor(['8C 8D 6S QS KD 7H', '10C AS JD 9H 7S QC'], '6H'), { mode: 'podkidnoy' }, [
        move(ME, { type: 'attack', card: card('8C') }),
        move('bot', { type: 'defend', attackIndex: 0, card: card('10C') }),
      ]),
    goal: {
      kind: 'move',
      accepts: (m) => m.type === 'pass',
      wrong: (m) => (m.type === 'attack' ? { kind: 'shouldPass' } : { kind: 'notNow' }),
    },
    focus: () => [],
    after: 'none',
  },
  durak: {
    id: 'durak',
    players: [ME, 'bot'],
    // A real game played on by GreedyBot until the stock is empty: I attack with 9♠ and 7♦ (♦ trump).
    build: () => {
      const start = createGame({ playerIds: [ME, 'bot'], seed: 50, config: { mode: 'podkidnoy' } });
      if (!start.ok) throw new Error('tutorial deal rejected');
      return fastForward(start.value, (s) => s.deck.length === 0 && s.phase.kind === 'awaitingAttack');
    },
    goal: { kind: 'win' },
    after: 'none',
  },
  transfer: {
    id: 'transfer',
    players: [ME, 'bot'],
    build: () =>
      buildGame([ME, 'bot'], deckFor(['7D 9C QS 10H JC 8D', '6H 7S KS AC 9S 8C'], '9H'), { mode: 'perevodnoy' }, [
        move('bot', { type: 'attack', card: card('7S') }),
      ]),
    goal: {
      kind: 'move',
      accepts: (m) => m.type === 'transfer',
      wrong: () => ({ kind: 'shouldTransfer', card: card('7D') }),
    },
    focus: () => cards('7D'),
    after: 'untilMyTurn',
  },
  teams: {
    id: 'teams',
    // Seats 0+2 (me + my partner) vs 1+3. My partner holds the lowest trump (6♥) and attacks east (seat 3).
    players: [ME, 'west', 'partner', 'east'],
    partner: 'partner',
    build: () =>
      buildGame(
        [ME, 'west', 'partner', 'east'],
        deckFor(['9D 6S QS KC 7D 10H', '8S JS AC 8D QD JH', '6H 9C 7S 10C AD KS', '10S JC QC 8C KD AH'], 'QH'),
        { mode: 'podkidnoy', teams: true },
        [move('partner', { type: 'attack', card: card('9C') })],
      ),
    goal: {
      kind: 'move',
      accepts: (m) => m.type === 'attack',
      wrong: (m) => (m.type === 'pass' ? { kind: 'shouldThrowIn' } : { kind: 'notNow' }),
    },
    focus: () => cards('9D'),
    after: 'untilMyTurn',
  },
  practice: {
    id: 'practice',
    players: [ME, 'bot'],
    build: (seed) => {
      const start = createGame({ playerIds: [ME, 'bot'], seed, config: { mode: 'podkidnoy' } });
      if (!start.ok) throw new Error('tutorial deal rejected');
      return start.value;
    },
    goal: { kind: 'free' },
    after: 'none',
  },
};

export function lesson(id: TutorialGameId): Lesson {
  return LESSONS[id];
}

export const isLessonId = (id: string): id is LessonId => (LESSON_IDS as readonly string[]).includes(id);

/**
 * Why a hand card I tapped can't be played right now (a dimmed card), from the table alone.
 * Defending: compared with the uncovered attack card of its suit (or the first uncovered one).
 */
export function explainTap(state: GameState, tapped: Card): Reason {
  const me = state.players.findIndex((p) => p.id === ME);
  const phase = state.phase;
  if (phase.kind !== 'bout') return { kind: 'notNow' };
  const trump = state.trumpCard.suit;
  if (state.defenderIndex === me && !phase.taking) {
    const open = uncovered(state);
    const target = open.find((c) => c.suit === tapped.suit) ?? open[0];
    if (!target) return { kind: 'notNow' };
    if (tapped.suit === target.suit) {
      return target.suit === trump ? { kind: 'trumpNeedsHigherTrump', card: tapped, target } : { kind: 'lowerSameSuit', card: tapped, target };
    }
    if (target.suit === trump) return { kind: 'trumpNeedsHigherTrump', card: tapped, target };
    return { kind: 'otherSuit', card: tapped, target };
  }
  if (state.defenderIndex !== me) {
    const ranks = state.table.flatMap((p) => (p.defense ? [p.attack.rank, p.defense.rank] : [p.attack.rank]));
    return ranks.includes(tapped.rank) ? { kind: 'tableLimit' } : { kind: 'rankNotOnTable', card: tapped };
  }
  return { kind: 'notNow' };
}

export const pickedAll = (goal: Goal, picked: readonly Card[]) => goal.kind === 'pick' && goal.cards.every((c) => has(picked, c));
export const isGoalCard = (goal: Goal, c: Card) => goal.kind === 'pick' && has(goal.cards, c);
