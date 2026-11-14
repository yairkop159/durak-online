import { applyMove, createGame, createRng, getLegalMoves, getPlayersToAct, type GameState } from '@durak/game-engine';
import { cardId, type GameMode, type Move } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { gameEvents, resolvedBout, type GameEvent, type PlayRole } from '../src/services/gameEvents.js';

const tableCards = (pairs: GameState['table']) => pairs.reduce((n, p) => n + (p.defense ? 2 : 1), 0);

/** Random games; `onStep` sees every applied move with the states around it. */
function playRandom(
  players: number,
  mode: GameMode,
  seed: number,
  onStep: (prev: GameState, move: Move, next: GameState) => void,
): GameState {
  const created = createGame({ playerIds: Array.from({ length: players }, (_, i) => `p${i}`), seed, config: { mode } });
  if (!created.ok) throw new Error(created.error.message);
  const rng = createRng(seed ^ 0x5bd1e995);
  let state = created.value;
  for (let step = 0; step < 5000 && state.phase.kind !== 'finished'; step++) {
    const actors = getPlayersToAct(state);
    const moves = getLegalMoves(state, actors[rng.nextInt(actors.length)]!);
    const nonPass = moves.filter((m) => m.type !== 'pass');
    const pool = nonPass.length > 0 && rng.next() < 0.7 ? nonPass : moves;
    const move = pool[rng.nextInt(pool.length)]!;
    const result = applyMove(state, move);
    if (!result.ok) throw new Error(result.error.code);
    onStep(state, move, result.value);
    state = result.value;
  }
  return state;
}

const expectedRole = (prev: GameState, move: Move): PlayRole | null => {
  switch (move.type) {
    case 'attack':
      return prev.table.length === 0 ? 'open' : 'throwIn';
    case 'defend':
      return 'defend';
    case 'transfer':
      return 'transfer';
    default:
      return null;
  }
};

describe('gameEvents (public step events from consecutive states)', () => {
  it('attributes every played card to its player and role, and reports every resolution and finish', () => {
    const seen = new Set<string>();
    for (const mode of ['podkidnoy', 'perevodnoy'] as const) {
      for (const players of [2, 3, 4, 6]) {
        for (let seed = 1; seed <= 6; seed++) {
          playRandom(players, mode, seed * 101 + players, (prev, move, next) => {
            const events = gameEvents(prev, next);
            const played = events.filter((e): e is Extract<GameEvent, { type: 'played' }> => e.type === 'played');
            const role = expectedRole(prev, move);
            if (role === null) {
              expect(played).toEqual([]);
            } else {
              expect(played).toHaveLength(1);
              expect(played[0]).toMatchObject({ by: move.playerId, role });
              if ('card' in move) expect(cardId(played[0]!.card)).toBe(cardId(move.card));
              seen.add(role);
            }
            const resolved = events.find((e) => e.type === 'resolved');
            expect(resolved !== undefined).toBe(resolvedBout(prev, next));
            if (resolved && resolved.type === 'resolved') {
              seen.add(resolved.outcome);
              expect(resolved.cards).toBe(tableCards(next.lastBout!.table));
              expect(resolved.cards).toBe(tableCards(prev.table) + (role === null ? 0 : 1));
            }
            const out = events.filter((e) => e.type === 'wentOut').map((e) => (e as { playerId: string }).playerId);
            expect(out).toEqual(next.finishOrder.filter((id) => !prev.finishOrder.includes(id)));
            const finished = events.find((e) => e.type === 'finished');
            expect(finished !== undefined).toBe(next.phase.kind === 'finished');
          });
        }
      }
    }
    expect([...seen].sort()).toEqual(['beaten', 'defend', 'open', 'taken', 'throwIn', 'transfer']);
  });

  it('a resign reports the finish but nobody "went out" and no resolution', () => {
    const created = createGame({ playerIds: ['a', 'b', 'c'], seed: 3, config: {} });
    if (!created.ok) throw new Error('setup');
    const prev = created.value;
    const next: GameState = { ...prev, phase: { kind: 'finished', durak: 'a' }, finishOrder: ['b', 'c'] };
    expect(gameEvents(prev, next)).toEqual([{ type: 'finished', durak: 'a' }]);
    expect(gameEvents(next, next)).toEqual([]);
  });
});
