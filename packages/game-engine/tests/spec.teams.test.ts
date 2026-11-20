/**
 * Executable version of the "Teams" rules in CLAUDE.md (2v2: seats 0+2 vs 1+3).
 * Seats here: a (0, team 0), b (1, team 1), c (2, team 0), d (3, team 1). a+c are partners, b+d too.
 */
import { losingTeam } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import {
  createGame,
  getAwaitedPlayers,
  getLegalMoves,
  getLegalMovesForView,
  getTimeoutMoves,
  resign,
  sanitizeStateForPlayer,
  type GameState,
} from '../src/index.js';
import { c, expectError, idOf, makeState, play, playAll } from './helpers.js';

const TEAMS = { teams: true } as const;
const role = (s: GameState) => ({ attacker: idOf(s, s.attackerIndex), defender: idOf(s, s.defenderIndex) });

describe('teams: setup', () => {
  it('needs exactly 4 players', () => {
    for (const n of [2, 3, 5, 6]) {
      const r = createGame({ playerIds: Array.from({ length: n }, (_, i) => `p${i}`), seed: 1, config: TEAMS });
      expect(r.ok ? 'ok' : r.error.code).toBe('INVALID_CONFIG');
    }
    expect(createGame({ playerIds: ['a', 'b', 'c', 'd'], seed: 1, config: TEAMS }).ok).toBe(true);
  });

  it('the first defender is the next seat, always an opponent', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = createGame({ playerIds: ['a', 'b', 'c', 'd'], seed, config: TEAMS });
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.config.teams).toBe(true);
      expect((r.value.attackerIndex + r.value.defenderIndex) % 2).toBe(1);
    }
  });
});

describe('teams: only the attacking team throws in', () => {
  // Trump: diamonds. a attacks b with 7S; c (a's partner) and d (b's partner) hold sevens.
  const start = () =>
    makeState({
      hands: { a: '7S 8C', b: '9S 10H JH', c: '7C KC', d: '7H QC' },
      deck: '6C 6H 9C 9H AD',
      attacker: 'a',
      config: TEAMS,
    });

  it("the defender's partner can neither throw in nor pass; the attacker's partner can throw in", () => {
    const s = play(start(), { type: 'attack', playerId: 'a', card: c('7S') });
    expect(getLegalMoves(s, 'd')).toEqual([]);
    expectError(s, { type: 'attack', playerId: 'd', card: c('7H') }, 'NOT_YOUR_TURN');
    expectError(s, { type: 'pass', playerId: 'd' }, 'NOT_YOUR_TURN');
    expect(getLegalMoves(s, 'c').map((m) => m.type)).toEqual(['attack', 'pass']);
    // The view generator agrees (it is used by the web client and the bots).
    expect(getLegalMovesForView(sanitizeStateForPlayer(s, 'd'))).toEqual([]);
    expect(getLegalMovesForView(sanitizeStateForPlayer(s, 'c'))).toEqual([
      { type: 'attack', card: c('7C') },
      { type: 'pass' },
    ]);
  });

  it("the bout ends without waiting for the defender's partner; timeouts never await them", () => {
    let s = play(start(), { type: 'attack', playerId: 'a', card: c('7S') });
    // c can throw in (7C), so a timeout would make c pass; d is never awaited.
    expect(getAwaitedPlayers(s)).toEqual(['b', 'c']);
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') });
    // a holds no 7 or 9; c still could throw in. d is never asked.
    expect(getTimeoutMoves(s).map((m) => m.playerId)).toEqual(['c']);
    s = play(s, { type: 'pass', playerId: 'c' });
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    // Beaten: b attacks next, against the next opponent clockwise (c).
    expect(role(s)).toEqual({ attacker: 'b', defender: 'c' });
  });

  it('outside team mode the same seat may throw in at its neighbour (unchanged)', () => {
    const base = start();
    const { teams: _teams, ...config } = base.config;
    const s = play({ ...base, config }, { type: 'attack', playerId: 'a', card: c('7S') });
    expect(getLegalMoves(s, 'd').map((m) => m.type)).toEqual(['attack', 'pass']);
  });
});

describe('teams: the defender is the next active OPPONENT', () => {
  it('after a beaten bout, a partner who is next clockwise is skipped (b is out)', () => {
    // d attacks a; a beats it. a attacks next; clockwise from a: b (out), c (partner, skipped), d.
    const s0 = makeState({
      hands: { a: '9S 10C JC', b: '', c: 'QC KC', d: '7S 8H' },
      trump: 'AD',
      attacker: 'd',
      defender: 'a',
      finishOrder: ['b'],
      config: TEAMS,
    });
    let s = play(s0, { type: 'attack', playerId: 'd', card: c('7S') });
    expect(getLegalMoves(s, 'c')).toEqual([]); // a's partner
    // d holds no 7 or 9 and c may not throw in at a: the bout ends by itself.
    s = play(s, { type: 'defend', playerId: 'a', attackIndex: 0, card: c('9S') });
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    expect(role(s)).toEqual({ attacker: 'a', defender: 'd' });
  });

  it('after a take, the next active player after the defender attacks (either team)', () => {
    const s0 = makeState({
      hands: { a: '7S 8C', b: '10H JH', c: '9C KC', d: 'QC QH' },
      deck: '6C 6H 9H 6S 6D 10D AD',
      attacker: 'a',
      config: TEAMS,
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('7S') });
    s = play(s, { type: 'take', playerId: 'b' }); // nobody can throw in: the bout ends
    expect(role(s)).toEqual({ attacker: 'c', defender: 'd' });

    // The same take with c out: the next after b is d (b's partner); d attacks a.
    const s1 = makeState({
      hands: { a: '7S 8C', b: '10H JH', c: '', d: 'QC QH' },
      deck: '6C 6H 9H 6S AD',
      attacker: 'a',
      finishOrder: ['c'],
      config: TEAMS,
    });
    let t = play(s1, { type: 'attack', playerId: 'a', card: c('7S') });
    t = play(t, { type: 'take', playerId: 'b' });
    expect(role(t)).toEqual({ attacker: 'd', defender: 'a' });
  });
});

describe('teams: transfer goes to the next active opponent', () => {
  it('b transfers to c; b becomes the main attacker and d may throw in, a may not', () => {
    const s0 = makeState({
      hands: { a: '7S 8C', b: '7H JH', c: '9S 10S KC', d: '7C QC' },
      deck: '6C 6H 9H 6S AD',
      attacker: 'a',
      config: { ...TEAMS, mode: 'perevodnoy' },
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('7S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('7H') });
    expect(role(s)).toEqual({ attacker: 'b', defender: 'c' });
    expect(getLegalMoves(s, 'a')).toEqual([]); // c's partner
    expect(getLegalMoves(s, 'd').map((m) => m.type)).toEqual(['attack', 'pass']);
    expect(getLegalMovesForView(sanitizeStateForPlayer(s, 'a'))).toEqual([]);
  });

  it('with one player left on a team, the transfer bounces back (b is out)', () => {
    const s0 = makeState({
      hands: { a: '7S 7D 8C', b: '', c: '9S KC', d: '7H 7C QC KC' },
      trump: 'AD',
      attacker: 'a',
      defender: 'd',
      finishOrder: ['b'],
      config: { ...TEAMS, mode: 'perevodnoy' },
    });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('7S') });
    s = play(s, { type: 'transfer', playerId: 'd', card: c('7H') });
    expect(role(s)).toEqual({ attacker: 'd', defender: 'a' });
    expect(getLegalMoves(s, 'c')).toEqual([]); // a's partner, never at a
    s = play(s, { type: 'transfer', playerId: 'a', card: c('7D') });
    expect(role(s)).toEqual({ attacker: 'a', defender: 'd' });
    expect(getLegalMoves(s, 'c').map((m) => m.type)).toEqual(['pass']); // attacks d again; no seven to throw
  });
});

describe('teams: the end', () => {
  it('when the opponents are both out, the other team loses; the durak holds more cards', () => {
    // Stock empty, d is out; b beats a's attack with his last card and goes out.
    const s0 = makeState({
      hands: { a: '7S 8C 10C', b: '9S', c: 'JC QC KC AC', d: '' },
      trump: 'AD',
      attacker: 'a',
      finishOrder: ['d'],
      config: TEAMS,
    });
    const s = playAll(s0, [
      { type: 'attack', playerId: 'a', card: c('7S') },
      { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') }, // nobody can throw in: the bout ends
    ]);
    expect(s.phase).toEqual({ kind: 'finished', durak: 'c' });
    expect(s.finishOrder).toEqual(['d', 'b']); // c's partner a is NOT added: still holding cards
    expect(losingTeam(s)).toBe(0);
  });

  it('a tie in cards: the first of them clockwise from the seat that just defended', () => {
    // b defended (seat 1): clockwise from b, c comes before a.
    const tieAfterB = makeState({
      hands: { a: '7S 8C 10C', b: '9S', c: 'JC QC', d: '' },
      trump: 'AD',
      attacker: 'a',
      finishOrder: ['d'],
      config: TEAMS,
    });
    let s = playAll(tieAfterB, [
      { type: 'attack', playerId: 'a', card: c('7S') },
      { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') }, // nobody can throw in: the bout ends
    ]);
    expect(s.phase).toEqual({ kind: 'finished', durak: 'c' });

    // d defended (seat 3): clockwise from d, a comes before c.
    const tieAfterD = makeState({
      hands: { a: 'JC QC', b: '', c: '7S 8C 10C', d: '9S' },
      trump: 'AD',
      attacker: 'c',
      defender: 'd',
      finishOrder: ['b'],
      config: TEAMS,
    });
    s = playAll(tieAfterD, [
      { type: 'attack', playerId: 'c', card: c('7S') },
      { type: 'defend', playerId: 'd', attackIndex: 0, card: c('9S') },
    ]);
    expect(s.phase).toEqual({ kind: 'finished', durak: 'a' });
  });

  it('the last players of both teams going out together is a draw', () => {
    const s0 = makeState({
      hands: { a: '7S', b: '9S', c: '', d: '' },
      trump: 'AD',
      attacker: 'a',
      finishOrder: ['c', 'd'],
      config: TEAMS,
    });
    const s = playAll(s0, [
      { type: 'attack', playerId: 'a', card: c('7S') },
      { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') },
    ]);
    expect(s.phase).toEqual({ kind: 'finished', durak: null });
    expect(losingTeam(s)).toBeNull();
  });

  it('the game goes on while both teams hold cards, even one player against two', () => {
    const s0 = makeState({
      hands: { a: '7S 8C', b: '9S', c: 'JC', d: 'QH KH' },
      trump: 'AD',
      attacker: 'a',
      config: TEAMS,
    });
    const s = playAll(s0, [
      { type: 'attack', playerId: 'a', card: c('7S') },
      { type: 'defend', playerId: 'b', attackIndex: 0, card: c('9S') }, // nobody can throw in: the bout ends
    ]);
    expect(s.finishOrder).toEqual(['b']);
    expect(s.phase).toEqual({ kind: 'awaitingAttack' });
    // Beaten, but b went out: the next active after b is c; c attacks d.
    expect(role(s)).toEqual({ attacker: 'c', defender: 'd' });
  });

  it("a resignation makes the leaver the durak, so the leaver's team loses", () => {
    const r = createGame({ playerIds: ['a', 'b', 'c', 'd'], seed: 7, config: TEAMS });
    if (!r.ok) throw new Error(r.error.message);
    const resigned = resign(r.value, 'd');
    if (!resigned.ok) throw new Error(resigned.error.message);
    const s = resigned.value;
    expect(s.phase).toEqual({ kind: 'finished', durak: 'd' });
    expect(losingTeam(s)).toBe(1);
  });
});
