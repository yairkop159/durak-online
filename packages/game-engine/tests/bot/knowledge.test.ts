import { DEFAULT_GAME_CONFIG, cardId, type Move, type PlayerView } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import {
  createGame,
  initKnowledge,
  sanitizeStateForPlayer,
  unseenCards,
  updateKnowledge,
  type GameState,
  type PublicKnowledge,
} from '../../src/index.js';
import { c, makeState, play } from '../helpers.js';

/** Plays `moves` from `state`, keeping `viewer`'s knowledge up to date from consecutive views only. */
function track(
  state: GameState,
  viewer: string,
  moves: Move[],
  k0?: PublicKnowledge,
): { state: GameState; k: PublicKnowledge } {
  let view = sanitizeStateForPlayer(state, viewer);
  let k = k0 ?? initKnowledge(view);
  for (const move of moves) {
    state = play(state, move);
    const next = sanitizeStateForPlayer(state, viewer);
    k = updateKnowledge(k, view, next);
    view = next;
  }
  return { state, k };
}

const twoPlayers = () =>
  makeState({
    hands: { p0: '7S 8D 9C JH QD KC', p1: '9S 6C 7C 10D 6D 7H' },
    deck: '8C 9D 10C JC QC KD 6H',
    trump: '6H',
  });

const takeBout: Move[] = [
  { type: 'attack', playerId: 'p0', card: c('7S') },
  { type: 'take', playerId: 'p1' },
];

describe('PublicKnowledge', () => {
  it('a take puts every table card in the taker’s known hand (for the other players)', () => {
    const { k } = track(twoPlayers(), 'p0', takeBout);
    expect(k.knownHands.p1).toEqual(['7S']);
    expect(k.discard).toEqual([]);
    // The taker learns nothing new about the attacker.
    expect(track(twoPlayers(), 'p1', takeBout).k.knownHands.p0).toEqual([]);
  });

  it('a beaten bout puts the table cards in the discard', () => {
    const { k } = track(twoPlayers(), 'p1', [
      { type: 'attack', playerId: 'p0', card: c('7S') },
      { type: 'defend', playerId: 'p1', attackIndex: 0, card: c('9S') },
      { type: 'pass', playerId: 'p0' },
    ]);
    expect([...k.discard].sort()).toEqual(['7S', '9S']);
    expect(k.knownHands.p0).toEqual([]);
  });

  it('a known card leaves the known hand as soon as it is played', () => {
    const first = track(twoPlayers(), 'p0', takeBout);
    // Bout 2: p0 attacks again (the defender took); p1 beats it, so p1 attacks bout 3 with the known 7S.
    const second = track(
      first.state,
      'p0',
      [
        { type: 'attack', playerId: 'p0', card: c('8D') },
        { type: 'defend', playerId: 'p1', attackIndex: 0, card: c('10D') },
        { type: 'pass', playerId: 'p0' },
      ],
      first.k,
    );
    expect(second.k.knownHands.p1).toEqual(['7S']);
    const third = track(second.state, 'p0', [{ type: 'attack', playerId: 'p1', card: c('7S') }], second.k);
    expect(third.k.knownHands.p1).toEqual([]);
  });

  it('when the stock runs out, the last drawer is known to hold the face-up trump', () => {
    const state = makeState({
      hands: { p0: '7S 8D 9C JH QD KC', p1: '9S 6C 7C 10D 6D 7H' },
      deck: '6H',
    });
    const moves: Move[] = [
      { type: 'attack', playerId: 'p0', card: c('7S') },
      { type: 'defend', playerId: 'p1', attackIndex: 0, card: c('9S') },
      { type: 'pass', playerId: 'p0' },
    ];
    expect(track(state, 'p1', moves).k.knownHands.p0).toEqual(['6H']);
    expect(track(state, 'p0', moves).k.knownHands.p1).toEqual([]);
  });

  it('an ambiguous closing throw-in leaves the drawn trump unassigned', () => {
    const base: PlayerView = {
      viewerId: 'p0',
      hand: [c('8S'), c('9S'), c('10S'), c('JS'), c('QS'), c('KS')],
      players: [
        { id: 'p0', handCount: 6, finished: false },
        { id: 'p1', handCount: 3, finished: false },
        { id: 'p2', handCount: 6, finished: false },
        { id: 'p3', handCount: 6, finished: false },
      ],
      deckCount: 1,
      trumpCard: c('6H'),
      trumpSuit: 'H',
      discardCount: 12,
      table: [{ attack: c('7S'), defense: null }],
      attackerId: 'p0',
      defenderId: 'p1',
      phase: { kind: 'bout', taking: true, passed: ['p0'] },
      boutNumber: 3,
      finishOrder: [],
      config: DEFAULT_GAME_CONFIG,
      lastBout: null,
    };
    // p2 or p3 threw in 7H (closing the bout); whoever it was drew the last card (the trump).
    const next: PlayerView = {
      ...base,
      players: [
        { id: 'p0', handCount: 6, finished: false },
        { id: 'p1', handCount: 5, finished: false },
        { id: 'p2', handCount: 6, finished: false },
        { id: 'p3', handCount: 6, finished: false },
      ],
      deckCount: 0,
      table: [],
      attackerId: 'p2',
      defenderId: 'p3',
      phase: { kind: 'awaitingAttack' },
      boutNumber: 4,
      lastBout: {
        table: [
          { attack: c('7S'), defense: null },
          { attack: c('7H'), defense: null },
        ],
        outcome: 'taken',
        defenderId: 'p1',
      },
    };
    const k = updateKnowledge(initKnowledge(base), base, next);
    expect([...k.knownHands.p1!].sort()).toEqual(['7H', '7S']);
    expect(k.knownHands.p2).toEqual([]);
    expect(k.knownHands.p3).toEqual([]);
  });

  it('with 6 players, the last seat holds the trump during bout 1', () => {
    const created = createGame({ playerIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], seed: 11 });
    if (!created.ok) throw new Error('setup');
    const trump = cardId(created.value.trumpCard);
    expect(created.value.players[5]!.hand.map(cardId)).toContain(trump);
    expect(initKnowledge(sanitizeStateForPlayer(created.value, 'p0')).knownHands.p5).toEqual([trump]);
    expect(Object.values(initKnowledge(sanitizeStateForPlayer(created.value, 'p5')).knownHands).flat()).toEqual([]);
  });

  it('a gap (missed bout) keeps the discard but forgets hand knowledge', () => {
    const { state, k } = track(twoPlayers(), 'p0', takeBout);
    expect(k.knownHands.p1).toEqual(['7S']);
    const view = sanitizeStateForPlayer(state, 'p0');
    const jumped: PlayerView = { ...view, boutNumber: view.boutNumber + 2 };
    const reset = updateKnowledge({ ...k, discard: ['AS'] }, view, jumped);
    expect(reset.knownHands.p1).toEqual([]);
    expect(reset.discard).toEqual(['AS']);
  });

  it('is plain JSON and the unseen cards fill exactly the hidden slots', () => {
    const { state, k } = track(twoPlayers(), 'p0', takeBout);
    expect(JSON.parse(JSON.stringify(k))).toEqual(k);
    const view = sanitizeStateForPlayer(state, 'p0');
    const known = Object.values(k.knownHands).flat().length;
    const hiddenSlots =
      view.players.filter((p) => p.id !== 'p0').reduce((n, p) => n + p.handCount, 0) -
      known +
      Math.max(0, view.deckCount - 1) +
      (view.discardCount - k.discard.length);
    // makeState does not conserve the 36 cards, so compare against the cards this position uses.
    expect(unseenCards(k, view).map(cardId)).not.toContain('7S');
    expect(hiddenSlots).toBeGreaterThan(0);
  });
});
