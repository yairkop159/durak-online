import type { GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import {
  applyMove,
  abandon,
  applyTimeout,
  createGame,
  createRng,
  getAwaitedPlayers,
  getLegalMoves,
  getPlayersToAct,
  getTimeoutMoves,
  resign,
  timeoutOpeningCard,
  type GameState,
} from '../src/index.js';
import { allCards, c, cards, isFullDeckPermutation, makeState, play } from './helpers.js';

describe('timeout opening card', () => {
  it('is the lowest non-trump, ties broken by suit order S, C, D, H', () => {
    expect(timeoutOpeningCard(cards('9H 7D 7C AS 6S'), 'S')).toEqual(c('7C'));
    expect(timeoutOpeningCard(cards('8H 8D 8C 8S'), 'H')).toEqual(c('8S'));
  });

  it('is the lowest trump when the hand holds only trumps', () => {
    expect(timeoutOpeningCard(cards('AH 9H 7H'), 'H')).toEqual(c('7H'));
  });
});

describe('getTimeoutMoves', () => {
  it('awaitingAttack: the attacker opens with the timeout opening card', () => {
    const s = makeState({ hands: { a: '6C 9S 7D', b: '8S' }, deck: 'AC', attacker: 'a' });
    expect(getTimeoutMoves(s)).toEqual([{ type: 'attack', playerId: 'a', card: c('7D') }]);
    expect(getAwaitedPlayers(s)).toEqual(['a']);
  });

  it('bout with an uncovered card: defender takes, then every throw-in-capable attacker passes', () => {
    const s = makeState({
      hands: { a: '6D 9C', b: '7H 8H QH', c: '6C', d: 'KD' },
      deck: 'AS',
      attacker: 'a',
      table: [['6S', null]],
    });
    // d holds no 6: it is not awaited.
    expect(getTimeoutMoves(s)).toEqual([
      { type: 'take', playerId: 'b' },
      { type: 'pass', playerId: 'a' },
      { type: 'pass', playerId: 'c' },
    ]);
  });

  it('skips players who already passed', () => {
    const s = makeState({
      hands: { a: '6D', b: '7H 8H QH', c: '6C' },
      deck: 'AS',
      attacker: 'a',
      table: [['6S', null]],
      phase: { kind: 'bout', taking: false, passed: ['a'] },
    });
    expect(getTimeoutMoves(s).map((m) => `${m.type}:${m.playerId}`)).toEqual(['take:b', 'pass:c']);
  });

  it('all covered or defender taking: only passes', () => {
    const covered = makeState({
      hands: { a: '7D', b: 'QH KH' },
      deck: 'AS',
      attacker: 'a',
      table: [['7S', '8S']],
    });
    expect(getTimeoutMoves(covered)).toEqual([{ type: 'pass', playerId: 'a' }]);

    const taking = makeState({
      hands: { a: '7D', b: 'QH KH' },
      deck: 'AS',
      attacker: 'a',
      table: [['7S', null]],
      phase: { kind: 'bout', taking: true, passed: [] },
    });
    expect(getTimeoutMoves(taking)).toEqual([{ type: 'pass', playerId: 'a' }]);
  });

  it('finished games have no timeout moves', () => {
    const s = makeState({ hands: { a: '', b: '6S' }, attacker: 'a', phase: { kind: 'finished', durak: 'b' } });
    expect(getTimeoutMoves(s)).toEqual([]);
    expect(applyTimeout(s).ok).toBe(false);
  });
});

describe('applyTimeout', () => {
  it('skips moves made obsolete by earlier ones and reports who timed out', () => {
    // b takes; a is then blocked by the hand-size limit, so the bout ends on the take.
    const s = makeState({
      hands: { a: '6D', b: '7H' },
      deck: 'QC KC AS',
      attacker: 'a',
      table: [['6S', null]],
    });
    const result = applyTimeout(s);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.timedOut).toEqual(['b']);
    expect(result.value.state.phase).toEqual({ kind: 'awaitingAttack' });
    expect(result.value.state.players[1]!.hand).toEqual(cards('7H 6S'));
  });

  it('opens a bout when one is awaited (clubs are trump, so 9S is the lowest non-trump)', () => {
    const s = makeState({ hands: { a: '6C 9S', b: '8S' }, deck: 'AC', attacker: 'a' });
    const result = applyTimeout(s);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.timedOut).toEqual(['a']);
    expect(result.value.state.table).toEqual([{ attack: c('9S'), defense: null }]);
  });
});

describe('abandon', () => {
  it('ends the game with no durak and everyone still in appended to finishOrder', () => {
    const s = makeState({
      hands: { a: '6S 7S', b: '8H', c: '9D', d: '' },
      deck: 'AC',
      attacker: 'b',
      defender: 'c',
      finishOrder: ['d'],
    });
    const result = abandon(s);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.phase).toEqual({ kind: 'finished', durak: null });
    expect(result.value.finishOrder).toEqual(['d', 'b', 'c', 'a']);
    expect(result.value.players).toEqual(s.players);
    expect(abandon(result.value)).toMatchObject({ ok: false, error: { code: 'GAME_FINISHED' } });
  });
});

describe('resign', () => {
  const s0 = () =>
    makeState({
      hands: { a: '6S 7S', b: '8H', c: '9D', d: '' },
      deck: 'AC',
      attacker: 'b',
      defender: 'c',
      finishOrder: ['d'],
    });

  it('ends the game immediately with the resigning player as durak', () => {
    const result = resign(s0(), 'a');
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.phase).toEqual({ kind: 'finished', durak: 'a' });
    // Remaining players appended in seat order from the main attacker (b).
    expect(result.value.finishOrder).toEqual(['d', 'b', 'c']);
    expect(result.value.players).toEqual(s0().players);
  });

  it('works mid-bout and keeps every card accounted for', () => {
    const created = createGame({ playerIds: ['x', 'y', 'z'], seed: 5 });
    if (!created.ok) throw new Error('setup');
    let s = created.value;
    const attacker = s.players[s.attackerIndex]!;
    s = play(s, { type: 'attack', playerId: attacker.id, card: attacker.hand[0]! });
    const result = resign(s, s.players[s.defenderIndex]!.id);
    if (!result.ok) throw new Error(result.error.message);
    expect(isFullDeckPermutation(allCards(result.value))).toBe(true);
    expect(result.value.finishOrder).toHaveLength(2);
  });

  it('rejects finished games, unknown players and players who are already out', () => {
    expect(resign(s0(), 'zed')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAYER' } });
    expect(resign(s0(), 'd')).toMatchObject({ ok: false, error: { code: 'PLAYER_FINISHED' } });
    const done = resign(s0(), 'a');
    if (!done.ok) throw new Error('setup');
    expect(resign(done.value, 'b')).toMatchObject({ ok: false, error: { code: 'GAME_FINISHED' } });
  });
});

// ---------------------------------------------------------------------------
// Property tests: timeouts always make progress and games driven by them terminate.
// ---------------------------------------------------------------------------

function newGame(players: number, mode: GameMode, seed: number): GameState {
  const created = createGame({ playerIds: Array.from({ length: players }, (_, i) => `p${i}`), seed, config: { mode } });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function checkTimeoutStep(before: GameState, after: GameState): void {
  expect(after).not.toEqual(before); // progress: never a no-op
  expect(isFullDeckPermutation(allCards(after))).toBe(true);
}

describe('timeout progress (property tests)', () => {
  for (const mode of ['podkidnoy', 'perevodnoy'] as const) {
    for (const players of [2, 3, 4, 5, 6]) {
      it(`${players} players, ${mode}: every timeout step makes progress and keeps the invariants`, () => {
        for (let seed = 1; seed <= 25; seed++) {
          let state = newGame(players, mode, seed * 104729 + players);
          for (let step = 0; step < 300 && state.phase.kind !== 'finished'; step++) {
            expect(getAwaitedPlayers(state).length).toBeGreaterThan(0);
            const result = applyTimeout(state);
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
            expect(result.value.timedOut.length).toBeGreaterThan(0);
            checkTimeoutStep(state, result.value.state);
            state = result.value.state;
          }
        }
      });

      it(`${players} players, ${mode}: random moves mixed with timeouts terminate`, () => {
        for (let seed = 1; seed <= 25; seed++) {
          const rng = createRng(seed);
          let state = newGame(players, mode, seed * 7 + players);
          for (let step = 0; state.phase.kind !== 'finished'; step++) {
            if (step > 3000) throw new Error('did not terminate');
            expect(getAwaitedPlayers(state).length).toBeGreaterThan(0);
            if (rng.next() < 0.3) {
              const result = applyTimeout(state);
              if (!result.ok) throw new Error(result.error.message);
              checkTimeoutStep(state, result.value.state);
              state = result.value.state;
              continue;
            }
            const actors = getPlayersToAct(state);
            const moves = getLegalMoves(state, actors[rng.nextInt(actors.length)]!);
            const result = applyMove(state, moves[rng.nextInt(moves.length)]!);
            if (!result.ok) throw new Error(result.error.message);
            state = result.value;
          }
        }
      });
    }
  }
});

/**
 * Regression / known limitation: with "defender -> take", a timeout-only game can cycle forever.
 * Each take leaves the taker above six cards, so nobody draws from the stock (even with 16 cards
 * left), nothing is discarded, and one card circulates A -> B -> C. This is why the server has
 * an abandon guard (CLAUDE.md "Turn timers & AFK").
 */
describe('timeout-only cycle (why the server needs an abandon guard)', () => {
  it('a 3-player timeout-only game enters a repeating cycle with cards still in the stock', () => {
    let state = newGame(3, 'podkidnoy', 1 * 104729 + 3);
    const seen = new Set<string>();
    let repeated = false;
    for (let step = 0; step < 1000 && state.phase.kind !== 'finished'; step++) {
      // Hands compared as sets: a take appends cards, so array order alone is not meaningful.
      const hands = state.players.map((p) => p.hand.map((x) => `${x.rank}${x.suit}`).sort());
      const key = JSON.stringify([hands, state.table, state.attackerIndex, state.defenderIndex, state.phase, state.deck.length]);
      if (seen.has(key)) {
        repeated = true;
        break;
      }
      seen.add(key);
      const result = applyTimeout(state);
      if (!result.ok) throw new Error(result.error.message);
      state = result.value.state;
    }
    expect(state.phase.kind).not.toBe('finished');
    expect(repeated).toBe(true);
    expect(state.deck.length).toBeGreaterThan(0);
  });
});
