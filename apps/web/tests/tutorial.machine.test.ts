import { getLegalMoves, getLegalMovesForView, moveKey, sanitizeStateForPlayer, type GameState } from '@durak/game-engine';
import { cardId, type ClientMove } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { LESSON_IDS, lesson, type TutorialGameId } from '../src/tutorial/lessons';
import { pendingOpponent, startLesson, tutorialReducer, type TutorialEvent, type TutorialState } from '../src/tutorial/machine';
import { ME, actorOf, card, greedyMove, mustApply } from '../src/tutorial/setup';
import { SOLUTIONS, drain, mv, tap, winningLine } from './tutorialSolutions';


/** The view's legal moves equal the engine's, for every seat (the table only ever offers these). */
function checkViews(game: GameState) {
  for (const p of game.players) {
    const fromView = getLegalMovesForView(sanitizeStateForPlayer(game, p.id)).map(moveKey).sort();
    const fromState = getLegalMoves(game, p.id).map(moveKey).sort();
    expect(fromView).toEqual(fromState);
  }
}

/** Applies the events, then lets the opponents answer until nobody is due, checking every step. */
function run(state: TutorialState, events: readonly TutorialEvent[]): TutorialState {
  checkViews(state.game);
  for (const event of events) {
    state = drain(tutorialReducer(state, event), (_, next) => checkViews(next.game));
    checkViews(state.game);
  }
  return state;
}

describe('tutorial lessons (built through the engine, completable)', () => {
  it.each(Object.entries(SOLUTIONS))('%s: the solution line succeeds', (id, events) => {
    const end = run(startLesson(id as TutorialGameId), events);
    expect(end.phase).toBe('success');
  });

  it('every lesson starts in a playable position for me', () => {
    for (const id of LESSON_IDS) {
      const s = startLesson(id);
      expect(s.phase, id).toBe('playing');
      expect(s.game.phase.kind, id).not.toBe('finished');
      if (lesson(id).goal.kind !== 'pick') expect(getLegalMoves(s.game, ME).length, id).toBeGreaterThan(0);
    }
  });

  it('the endgame: stock empty, I attack with 2 cards, and a winning line exists', () => {
    const s = startLesson('durak');
    expect(s.game.deck).toHaveLength(0);
    expect(s.game.players[0]!.hand.map(cardId).sort()).toEqual(['7D', '9S']);
    const line = winningLine(s);
    expect(line).not.toBeNull();
    expect(run(s, line!).phase).toBe('success');
  });

  it('the endgame: taking when I could beat leaves me the durak → failed, then retry rebuilds', () => {
    // 9♠ is beaten (the bot then attacks), I take instead of defending with 7♦ and stay the durak.
    let s = run(startLesson('durak'), [mv({ type: 'attack', card: card('9S') })]);
    for (let i = 0; i < 50 && s.phase === 'playing'; i++) {
      const legal = getLegalMoves(s.game, ME).map(({ playerId: _, ...m }) => m as ClientMove);
      s = run(s, [mv(legal.find((m) => m.type === 'take') ?? legal[0]!)]);
    }
    expect(s.phase).toBe('failed');
    expect(s.reason).toEqual({ kind: 'durak' });
    const again = tutorialReducer(s, { type: 'retry' });
    expect(again.phase).toBe('playing');
    expect(again.attempt).toBe(1);
    expect(again.game).toEqual(startLesson('durak').game);
  });

  it('the practice game runs to the end against GreedyBot', () => {
    let s = startLesson('practice', 1234);
    s = drain(s);
    for (let i = 0; i < 300 && s.phase === 'playing'; i++) {
      if (actorOf(s.game) === ME) {
        const { playerId: _, ...m } = greedyMove(s.game, ME)!;
        s = run(s, [mv(m as ClientMove)]);
      } else {
        // I may act out of turn too (a throw-in): nothing pending means it's my move.
        const legal = getLegalMoves(s.game, ME);
        const { playerId: _, ...m } = legal[0]!;
        s = run(s, [mv(m as ClientMove)]);
      }
    }
    expect(s.phase).toBe('success');
    expect(s.game.phase.kind).toBe('finished');
  });

  it('is deterministic: the same events give the same states', () => {
    for (const [id, events] of Object.entries(SOLUTIONS)) {
      expect(run(startLesson(id as TutorialGameId), events)).toEqual(run(startLesson(id as TutorialGameId), events));
    }
  });
});

describe('wrong moves are explained and never applied', () => {
  const cases: [TutorialGameId, TutorialEvent, unknown][] = [
    ['trump', tap('6S', true), { kind: 'notTrump', card: card('6S') }],
    ['attack', mv({ type: 'attack', card: card('7H') }), { kind: 'saveTrump', card: card('7H') }],
    ['defend-suit', mv({ type: 'take' }), { kind: 'canBeat' }],
    ['defend-suit', mv({ type: 'defend', attackIndex: 0, card: card('JH') }), { kind: 'saveTrump', card: card('JH') }],
    ['defend-suit', tap('6C', false), { kind: 'lowerSameSuit', card: card('6C'), target: card('8C') }],
    ['defend-suit', tap('7S', false), { kind: 'otherSuit', card: card('7S'), target: card('8C') }],
    ['defend-trump', mv({ type: 'take' }), { kind: 'canBeat' }],
    ['defend-trump', tap('7D', false), { kind: 'lowerSameSuit', card: card('7D'), target: card('AD') }],
    ['take', tap('9S', false), { kind: 'lowerSameSuit', card: card('9S'), target: card('10S') }],
    ['throw-in', mv({ type: 'pass' }), { kind: 'shouldThrowIn' }],
    ['throw-in', tap('QS', false), { kind: 'rankNotOnTable', card: card('QS') }],
    ['bout-end', mv({ type: 'attack', card: card('8D') }), { kind: 'shouldPass' }],
    ['transfer', mv({ type: 'take' }), { kind: 'shouldTransfer', card: card('7D') }],
    ['transfer', mv({ type: 'defend', attackIndex: 0, card: card('QS') }), { kind: 'shouldTransfer', card: card('7D') }],
    ['teams', mv({ type: 'pass' }), { kind: 'shouldThrowIn' }],
  ];

  it.each(cases)('%s: %j', (id, event, reason) => {
    const start = startLesson(id);
    const wrong = tutorialReducer(start, event);
    expect(wrong.phase).toBe('wrong');
    expect(wrong.reason).toEqual(reason);
    expect(wrong.game).toBe(start.game);
    expect(wrong.version).toBe(0);
    // While the explanation shows, nothing else happens; "try again" returns to the same position.
    expect(tutorialReducer(wrong, mv({ type: 'take' }))).toBe(wrong);
    const back = tutorialReducer(wrong, { type: 'dismiss' });
    expect(back.phase).toBe('playing');
    expect(back.game).toBe(start.game);
  });

  it('an illegal move never reaches the engine', () => {
    const start = startLesson('defend-suit');
    expect(tutorialReducer(start, mv({ type: 'defend', attackIndex: 0, card: card('6C') }))).toBe(start);
  });

  it('a playable tap is left to the table (except in a pick lesson)', () => {
    const start = startLesson('defend-suit');
    expect(tutorialReducer(start, tap('10C', true))).toBe(start);
  });

  it('opponents wait for my goal move (no move is due while I am learning)', () => {
    for (const id of LESSON_IDS) {
      if (id === 'durak') continue;
      expect(pendingOpponent(startLesson(id)), id).toBeNull();
    }
  });

  it('a pick lesson ignores a card picked twice and counts progress', () => {
    const one = tutorialReducer(startLesson('trump'), tap('7H', true));
    expect(one.phase).toBe('playing');
    expect(tutorialReducer(one, tap('7H', true))).toBe(one);
    expect(one.picked).toEqual([card('7H')]);
  });

  it('the scripted positions are the documented ones', () => {
    expect(startLesson('defend-suit').game.table.map((p) => cardId(p.attack))).toEqual(['8C']);
    expect(startLesson('throw-in').game.table.map((p) => [cardId(p.attack), p.defense && cardId(p.defense)])).toEqual([['7S', '9S']]);
    const teams = startLesson('teams').game;
    expect(teams.players[teams.attackerIndex]!.id).toBe('partner');
    expect(teams.players[teams.defenderIndex]!.id).toBe('east');
    expect(mustApply).toBeTypeOf('function');
  });
});
