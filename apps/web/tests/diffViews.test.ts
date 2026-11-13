import { applyMove, applyTimeout, sanitizeStateForPlayer, type GameState } from '@durak/game-engine';
import { DEFAULT_GAME_CONFIG, type GameConfig, type Move, type PlayerView } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { diffViews, type AnimationEvent } from '../src/anim/diffViews';
import { c, cards } from './helpers';

/**
 * Fixtures come from the real engine: a hand-built GameState, real `applyMove`s, and the views
 * the server would send (`sanitizeStateForPlayer`). Card conservation isn't needed here.
 */
interface Spec {
  hands: Record<string, string>;
  deck?: string;
  attacker: string;
  defender: string;
  table?: [string, string | null][];
  taking?: boolean;
  config?: Partial<GameConfig>;
}

function makeState(spec: Spec): GameState {
  const ids = Object.keys(spec.hands);
  const deck = cards(spec.deck ?? '');
  const table = (spec.table ?? []).map(([a, d]) => ({ attack: c(a), defense: d ? c(d) : null }));
  return {
    config: { ...DEFAULT_GAME_CONFIG, ...spec.config },
    players: ids.map((id) => ({ id, hand: cards(spec.hands[id]!) })),
    deck,
    trumpCard: deck[deck.length - 1] ?? c('6D'),
    discard: cards('AH KH'),
    table,
    attackerIndex: ids.indexOf(spec.attacker),
    defenderIndex: ids.indexOf(spec.defender),
    phase: table.length ? { kind: 'bout', taking: spec.taking ?? false, passed: [] } : { kind: 'awaitingAttack' },
    boutNumber: 2,
    finishOrder: [],
    lastBout: null,
  };
}

function play(state: GameState, move: Move): GameState {
  const result = applyMove(state, move);
  if (!result.ok) throw new Error(`${JSON.stringify(move)} -> ${result.error.code}`);
  return result.value;
}

/** diffViews between two states, as seen by `viewer` (null = spectator). */
function diff(before: GameState, after: GameState, viewer: string | null): AnimationEvent[] {
  return diffViews(sanitizeStateForPlayer(before, viewer), sanitizeStateForPlayer(after, viewer));
}

const me = { kind: 'myHand' } as const;
const seat = (playerId: string) => ({ kind: 'seat', playerId }) as const;

describe('diffViews: plays within a bout', () => {
  const opening = () =>
    makeState({ hands: { me: '6S 6H 9C', bob: '7S KH QH 8H', carl: '6C 10C' }, deck: '6D 7D 8D', attacker: 'me', defender: 'bob' });

  it('my opening attack comes from my hand', () => {
    const s0 = opening();
    expect(diff(s0, play(s0, { type: 'attack', playerId: 'me', card: c('6S') }), 'me')).toEqual([
      { type: 'played', by: 'me', from: me, card: c('6S'), kind: 'attack', slot: { index: 0, role: 'attack' } },
    ]);
  });

  it("an opponent's throw-in is attributed from hand counts and comes from their seat", () => {
    const s1 = play(opening(), { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'attack', playerId: 'carl', card: c('6C') });
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'played', by: 'carl', from: seat('carl'), card: c('6C'), kind: 'throwIn', slot: { index: 1, role: 'attack' } },
    ]);
  });

  it('a defense that does not end the bout lands on its attack card', () => {
    const s1 = play(opening(), { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'defend', playerId: 'bob', attackIndex: 0, card: c('7S') });
    expect(s2.table).toHaveLength(1); // I can still throw in 6H
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'played', by: 'bob', from: seat('bob'), card: c('7S'), kind: 'defend', slot: { index: 0, role: 'defense' } },
    ]);
  });

  it('a transfer is a play by the old defender; the new defender is the next seat', () => {
    const s0 = makeState({
      hands: { me: '6S 9C', bob: '6H KH QH', carl: '10C JC QC' },
      deck: '6D 7D 8D',
      attacker: 'me',
      defender: 'bob',
      config: { mode: 'perevodnoy' },
    });
    const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'transfer', playerId: 'bob', card: c('6H') });
    expect(s2.players[s2.defenderIndex]!.id).toBe('carl');
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'played', by: 'bob', from: seat('bob'), card: c('6H'), kind: 'transfer', slot: { index: 1, role: 'attack' } },
    ]);
    // Seen by bob, the transfer came from his own hand.
    expect(diff(s1, s2, 'bob')[0]).toMatchObject({ by: 'bob', from: me });
  });

  it('take or pass alone (no new card) animates nothing', () => {
    const s1 = play(opening(), { type: 'attack', playerId: 'me', card: c('6S') });
    expect(diff(s1, play(s1, { type: 'take', playerId: 'bob' }), 'me')).toEqual([]);
  });
});

describe('diffViews: bout resolution', () => {
  // bob attacks me; neither of us has a second 6/7, so my cover ends the bout at once.
  const coverEnds = () =>
    makeState({
      hands: { me: '7S 8H 9H 10H JH QH', bob: 'AS 6S KC KD QC JC' },
      deck: '6C 7C 8C 9D',
      attacker: 'bob',
      defender: 'me',
    });

  it('my last cover ends the bout: played (from my hand) -> beaten -> draws in draw order', () => {
    const s1 = play(coverEnds(), { type: 'attack', playerId: 'bob', card: c('6S') });
    const s2 = play(s1, { type: 'defend', playerId: 'me', attackIndex: 0, card: c('7S') });
    expect(s2.table).toEqual([]);
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'played', by: 'me', from: me, card: c('7S'), kind: 'defend', slot: { index: 0, role: 'defense' } },
      { type: 'beaten', cards: cards('6S 7S') },
      // Draw order: the main attacker first, the defender last.
      { type: 'drawn', player: 'bob', to: seat('bob'), count: 1, cards: null, includesTrump: false },
      { type: 'drawn', player: 'me', to: me, count: 1, cards: cards('7C'), includesTrump: false },
      { type: 'deck', from: 4, to: 2, trumpGone: false },
    ]);
  });

  it("an opponent's last cover ends the bout: played (from their seat) -> beaten -> draws", () => {
    const s0 = makeState({
      hands: { me: 'AS 6S KC KD QC JC', bob: '7S 8H 9H 10H JH QH' },
      deck: '6C 7C 8C 9D',
      attacker: 'me',
      defender: 'bob',
    });
    const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'defend', playerId: 'bob', attackIndex: 0, card: c('7S') });
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'played', by: 'bob', from: seat('bob'), card: c('7S'), kind: 'defend', slot: { index: 0, role: 'defense' } },
      { type: 'beaten', cards: cards('6S 7S') },
      { type: 'drawn', player: 'me', to: me, count: 1, cards: cards('6C'), includesTrump: false },
      { type: 'drawn', player: 'bob', to: seat('bob'), count: 1, cards: null, includesTrump: false },
      { type: 'deck', from: 4, to: 2, trumpGone: false },
    ]);
  });

  it('a spectator sees every player as a seat and never any drawn card', () => {
    const s1 = play(coverEnds(), { type: 'attack', playerId: 'bob', card: c('6S') });
    const s2 = play(s1, { type: 'defend', playerId: 'me', attackIndex: 0, card: c('7S') });
    expect(diff(s1, s2, null)).toEqual([
      { type: 'played', by: 'me', from: seat('me'), card: c('7S'), kind: 'defend', slot: { index: 0, role: 'defense' } },
      { type: 'beaten', cards: cards('6S 7S') },
      { type: 'drawn', player: 'bob', to: seat('bob'), count: 1, cards: null, includesTrump: false },
      { type: 'drawn', player: 'me', to: seat('me'), count: 1, cards: null, includesTrump: false },
      { type: 'deck', from: 4, to: 2, trumpGone: false },
    ]);
  });

  it('I take: the exact table cards go to my hand, then only the others draw (taker excluded)', () => {
    const s1 = play(coverEnds(), { type: 'attack', playerId: 'bob', card: c('6S') });
    const s2 = play(s1, { type: 'take', playerId: 'me' });
    expect(s2.table).toEqual([]); // bob has nothing to throw in
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'taken', by: 'me', to: me, cards: cards('6S') },
      { type: 'drawn', player: 'bob', to: seat('bob'), count: 1, cards: null, includesTrump: false },
      { type: 'deck', from: 4, to: 3, trumpGone: false },
    ]);
  });

  it('an opponent takes: cards go to their seat (as backs), my draw shows my exact card', () => {
    const s0 = makeState({
      hands: { me: 'AS 6S KC KD QC JC', bob: '8H 9H 10H JH QH' },
      deck: '6C 7C 8C 9D',
      attacker: 'me',
      defender: 'bob',
    });
    const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'take', playerId: 'bob' });
    expect(diff(s1, s2, 'me')).toEqual([
      { type: 'taken', by: 'bob', to: seat('bob'), cards: cards('6S') },
      { type: 'drawn', player: 'me', to: me, count: 1, cards: cards('6C'), includesTrump: false },
      // bob now holds 6 cards and draws nothing.
      { type: 'deck', from: 4, to: 3, trumpGone: false },
    ]);
  });

  it('a timeout take (take + passes in one step) resolves like a normal take', () => {
    const s0 = makeState({
      hands: { me: '6H 9S KC KD QC', bob: '8H 9H 10H JH QH JD' },
      deck: '6C 7C 8C 9D',
      attacker: 'me',
      defender: 'bob',
      table: [['6S', null]],
    });
    const timed = applyTimeout(s0);
    if (!timed.ok) throw new Error(timed.error.code);
    expect(timed.value.timedOut).toEqual(['bob', 'me']);
    expect(diff(s0, timed.value.state, 'me')).toEqual([
      { type: 'taken', by: 'bob', to: seat('bob'), cards: cards('6S') },
      { type: 'drawn', player: 'me', to: me, count: 1, cards: cards('6C'), includesTrump: false },
      { type: 'deck', from: 4, to: 3, trumpGone: false },
    ]);
  });

  it("a throw-in that closes a take is attributed by replaying the refill, then taken", () => {
    // bob is taking with 2 cards; my 6H fills his limit and ends the bout.
    const s0 = makeState({
      hands: { me: '6H 9S KC KD QC JC', bob: '8H 9H' },
      deck: '6C 7C 8C 9D',
      attacker: 'me',
      defender: 'bob',
      table: [['6S', null]],
      taking: true,
    });
    const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6H') });
    expect(s1.table).toEqual([]);
    const taken = { type: 'taken', by: 'bob', cards: cards('6S 6H') };
    expect(diff(s0, s1, 'bob')).toEqual([
      { type: 'played', by: 'me', from: seat('me'), card: c('6H'), kind: 'throwIn', slot: { index: 1, role: 'attack' } },
      { ...taken, to: me },
      { type: 'drawn', player: 'me', to: seat('me'), count: 1, cards: null, includesTrump: false },
      // 2 + 2 taken = 4 cards: the taker still refills, last, with his exact cards.
      { type: 'drawn', player: 'bob', to: me, count: 2, cards: cards('7C 8C'), includesTrump: false },
      { type: 'deck', from: 4, to: 1, trumpGone: false },
    ]);
    expect(diff(s0, s1, 'me')[0]).toMatchObject({ by: 'me', from: me, kind: 'throwIn' });
  });

  it('the last card of the stock is the public trump', () => {
    const s0 = makeState({
      hands: { me: 'AS 6S KC KD QC JC', bob: '7S 8H 9H 10H JH QH' },
      deck: '9D',
      attacker: 'me',
      defender: 'bob',
    });
    const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6S') });
    const s2 = play(s1, { type: 'defend', playerId: 'bob', attackIndex: 0, card: c('7S') });
    // Seen by bob: I drew the trump (shown face-up, it was public); bob gets nothing.
    expect(diff(s1, s2, 'bob').slice(2)).toEqual([
      { type: 'drawn', player: 'me', to: seat('me'), count: 1, cards: null, includesTrump: true },
      { type: 'deck', from: 1, to: 0, trumpGone: true },
    ]);
    expect(diff(s1, s2, 'me')[2]).toEqual({ type: 'drawn', player: 'me', to: me, count: 1, cards: cards('9D'), includesTrump: true });
  });
});

describe('diffViews: guards (snap instead of animating)', () => {
  const s0 = makeState({ hands: { me: '6S 9C', bob: '7S KH' }, deck: '6D 7D', attacker: 'me', defender: 'bob' });
  const s1 = play(s0, { type: 'attack', playerId: 'me', card: c('6S') });

  it('different viewers', () => {
    expect(diffViews(sanitizeStateForPlayer(s0, 'me'), sanitizeStateForPlayer(s1, 'bob'))).toEqual([]);
  });

  it('a jump of more than one bout (resync)', () => {
    const view = sanitizeStateForPlayer(s1, 'me');
    const later: PlayerView = { ...view, boutNumber: view.boutNumber + 2 };
    expect(diffViews(sanitizeStateForPlayer(s0, 'me'), later)).toEqual([]);
  });

  it('a resolution without lastBout (inconsistent input)', () => {
    const view = sanitizeStateForPlayer(s1, 'me');
    const resolved: PlayerView = { ...view, table: [], boutNumber: view.boutNumber + 1, lastBout: null };
    expect(diffViews(view, resolved)).toEqual([]);
  });
});

describe('diffViews: property test over random engine games', () => {
  it('every step is explained: resolutions always animate, card plays always show up', async () => {
    const { createGame, createRng, getLegalMoves, getPlayersToAct } = await import('@durak/game-engine');
    for (const mode of ['podkidnoy', 'perevodnoy'] as const) {
      for (const players of [2, 3, 4, 6]) {
        for (let seed = 1; seed <= 15; seed++) {
          const ids = Array.from({ length: players }, (_, i) => `p${i}`);
          const created = createGame({ playerIds: ids, seed: seed * 101 + players, config: { mode } });
          if (!created.ok) throw new Error(created.error.code);
          const rng = createRng(seed);
          let state = created.value;
          for (let step = 0; step < 2000 && state.phase.kind !== 'finished'; step++) {
            const actors = getPlayersToAct(state);
            const moves = getLegalMoves(state, actors[rng.nextInt(actors.length)]!);
            const move = moves[rng.nextInt(moves.length)]!;
            const next = play(state, move);
            const resolved = next.lastBout !== state.lastBout;
            const tableGrew = next.table.length > state.table.length || next.table.some((p, i) => p.defense && !state.table[i]?.defense);
            for (const viewer of [...ids, null]) {
              const events = diff(state, next, viewer);
              const where = `${mode}/${players}/${seed}/${step}/${viewer}/${JSON.stringify(move)}`;
              if (resolved) {
                expect(events.some((e) => e.type === 'beaten' || e.type === 'taken'), where).toBe(true);
                const drawn = events.filter((e) => e.type === 'drawn').reduce((n, e) => n + (e.type === 'drawn' ? e.count : 0), 0);
                expect(drawn, where).toBeLessThanOrEqual(state.deck.length - next.deck.length);
              } else if (tableGrew) {
                expect(events.map((e) => e.type), where).toEqual(['played']);
              } else {
                expect(events, where).toEqual([]);
              }
              // Never a hidden card: drawn cards only for the viewer themself.
              for (const e of events) if (e.type === 'drawn' && e.cards) expect(e.player).toBe(viewer);
            }
            state = next;
          }
        }
      }
    }
  }, 60_000);
});
