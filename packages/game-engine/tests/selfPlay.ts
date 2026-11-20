/**
 * Random self-play property tests, shared by fuzz.podkidnoy.test.ts and fuzz.perevodnoy.test.ts.
 * Every (players, mode) case plays the same 40 seeds, split into chunks of 10 games per test so no
 * single synchronous block runs long (see tests/setup/eventLoop.ts).
 */
import { cardId, type ClientMove, type GameMode, type Move } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createGame,
  createRng,
  getLegalMoves,
  getLegalMovesForView,
  getPlayersToAct,
  sanitizeStateForPlayer,
  type GameState,
} from '../src/index.js';
import { checkInvariants } from './helpers.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * On the step that resolves a bout: `lastBout` is the previous table plus at most the one closing
 * card, and every card in it ended up in the discard (beaten) or the defender's hand (taken).
 */
function checkLastBout(before: GameState, after: GameState): void {
  const last = after.lastBout;
  expect(last).not.toBeNull();
  if (!last) return;
  const ids = (pairs: GameState['table']) => pairs.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack])).map(cardId);
  const lastIds = ids(last.table);
  const beforeIds = ids(before.table);
  expect(beforeIds.every((id) => lastIds.includes(id))).toBe(true);
  expect(lastIds.length - beforeIds.length).toBeLessThanOrEqual(1);
  expect(last.defenderId).toBe(before.players[before.defenderIndex]!.id);
  const where =
    last.outcome === 'beaten'
      ? after.discard.map(cardId)
      : after.players.find((p) => p.id === last.defenderId)!.hand.map(cardId);
  for (const id of lastIds) expect(where).toContain(id);
}

function moveKey(move: ClientMove): string {
  switch (move.type) {
    case 'attack':
    case 'transfer':
      return `${move.type}:${cardId(move.card)}`;
    case 'defend':
      return `defend:${move.attackIndex}:${cardId(move.card)}`;
    case 'take':
    case 'pass':
      return move.type;
  }
}

function toClientMove(move: Move): ClientMove {
  const { playerId: _playerId, ...client } = move;
  return client as ClientMove;
}

/** The view-only move generator must agree with the authoritative one for every seat. */
function checkViewParity(state: GameState): void {
  for (const player of state.players) {
    const fromView = getLegalMovesForView(sanitizeStateForPlayer(state, player.id)).map(moveKey).sort();
    const fromState = getLegalMoves(state, player.id).map(toClientMove).map(moveKey).sort();
    // Plain comparison first: `expect` on every step of 400 games is needlessly slow.
    if (fromView.join() !== fromState.join()) expect({ player: player.id, fromView }).toEqual({ player: player.id, fromState });
  }
  if (getLegalMovesForView(sanitizeStateForPlayer(state, null)).length !== 0) {
    expect(getLegalMovesForView(sanitizeStateForPlayer(state, null))).toEqual([]);
  }
}

/** Extra options for callers other than the classic fuzz tests (which pass none). */
export interface RandomGameOptions {
  /** 2v2 team mode (4 players). */
  readonly teams?: boolean;
  /** Called after every applied move with the state before, the move and the state after. */
  readonly onStep?: (before: GameState, move: Move, after: GameState) => void;
}

export function playRandomGame(players: number, mode: GameMode, seed: number, options: RandomGameOptions = {}): GameState {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  const config = options.teams ? { mode, teams: true } : { mode };
  const created = createGame({ playerIds: ids, seed, config });
  if (!created.ok) throw new Error(created.error.message);
  const rng = createRng(seed ^ 0x9e3779b9);
  let state = deepFreeze(created.value);

  for (let step = 0; step < 5000; step++) {
    checkInvariants(state);
    checkViewParity(state);
    if (state.phase.kind === 'finished') return state;

    const actors = getPlayersToAct(state);
    const actor = actors[rng.nextInt(actors.length)]!;
    const moves = getLegalMoves(state, actor);
    // Bias away from passing so games exercise long bouts and throw-ins.
    const nonPass = moves.filter((m) => m.type !== 'pass');
    const pool = nonPass.length > 0 && rng.next() < 0.7 ? nonPass : moves;
    const move = pool[rng.nextInt(pool.length)]!;

    const result = applyMove(state, move); // throws if the engine mutates the frozen input
    if (!result.ok) throw new Error(`Legal move rejected: ${JSON.stringify(move)} -> ${result.error.code}`);
    const before = state;
    state = deepFreeze(result.value);
    options.onStep?.(before, move, state);
    if (state.boutNumber !== before.boutNumber || (state.phase.kind === 'finished' && before.phase.kind === 'bout')) {
      checkLastBout(before, state);
    } else {
      expect(state.lastBout).toEqual(before.lastBout);
    }

    // The sanitized view must always be consistent with the real state.
    const view = sanitizeStateForPlayer(state, actor);
    expect(view.players.reduce((n, p) => n + p.handCount, 0) + view.deckCount + view.discardCount).toBe(
      36 - state.table.reduce((n, p) => n + (p.defense ? 2 : 1), 0),
    );
  }
  throw new Error(`Game ${players}/${mode}/${seed} did not terminate`);
}

export const SEEDS_PER_CASE = 40;
export const SEEDS_PER_TEST = 10;

function checkFinal(final: GameState, players: number): void {
  if (final.phase.kind !== 'finished') throw new Error('not finished');
  const durakCount = final.phase.durak === null ? 0 : 1;
  expect(final.finishOrder.length + durakCount).toBe(players);
  const durak = final.phase.durak;
  if (durak !== null) {
    expect(final.finishOrder).not.toContain(durak);
    expect(final.players.find((p) => p.id === durak)!.hand.length).toBeGreaterThan(0);
  }
  for (const id of final.finishOrder) {
    expect(final.players.find((p) => p.id === id)!.hand).toEqual([]);
  }
}

export function describeSelfPlay(mode: GameMode): void {
  describe(`random self-play, ${mode} (property tests)`, () => {
    for (const players of [2, 3, 4, 5, 6]) {
      for (let from = 1; from <= SEEDS_PER_CASE; from += SEEDS_PER_TEST) {
        const to = from + SEEDS_PER_TEST - 1;
        it(`${players} players: games ${from}-${to} of ${SEEDS_PER_CASE} terminate with every invariant holding`, () => {
          for (let seed = from; seed <= to; seed++) checkFinal(playRandomGame(players, mode, seed * 7919 + players), players);
        }, 60_000);
      }
    }
  });
}
