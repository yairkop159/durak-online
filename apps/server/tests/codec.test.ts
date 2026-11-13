import { applyMove } from '@durak/game-engine';
import { describe, expect, it, vi } from 'vitest';
import { StoredGameSchema, decode, encode } from '../src/repositories/redis/codec.js';
import { makeGame } from './repositories/fixtures.js';

const log = () => ({ error: vi.fn() });

describe('codec: GameState.lastBout (Phase 5b)', () => {
  it('a game stored before 5b (no lastBout field) still decodes, with lastBout = null', () => {
    const game = makeGame('room1');
    const { lastBout: _dropped, ...oldState } = game.state;
    const logger = log();
    const decoded = decode(StoredGameSchema, encode({ ...game, state: oldState }), 'k', logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(decoded?.state.lastBout).toBeNull();
    expect(decoded).toEqual(game);
  });

  it('round-trips a resolved bout summary', () => {
    const game = makeGame('room1');
    const attacker = game.state.players[game.state.attackerIndex]!;
    const defender = game.state.players[game.state.defenderIndex]!;
    const opened = applyMove(game.state, { type: 'attack', playerId: attacker.id, card: attacker.hand[0]! });
    if (!opened.ok) throw new Error(opened.error.message);
    const taken = applyMove(opened.value, { type: 'take', playerId: defender.id });
    if (!taken.ok) throw new Error(taken.error.message);
    // Every other player passes until the bout resolves.
    let state = taken.value;
    for (const p of state.players) {
      if (state.lastBout !== null || p.id === defender.id) continue;
      const passed = applyMove(state, { type: 'pass', playerId: p.id });
      if (passed.ok) state = passed.value;
    }
    expect(state.lastBout?.outcome).toBe('taken');
    const stored = { ...game, state };
    expect(decode(StoredGameSchema, encode(stored), 'k', log())).toEqual(stored);
  });

  it('rejects a malformed lastBout as a corrupted value (null, logged)', () => {
    const game = makeGame('room1');
    const logger = log();
    const bad = { ...game, state: { ...game.state, lastBout: { table: [], outcome: 'lost', defenderId: 'x' } } };
    expect(decode(StoredGameSchema, encode(bad), 'k', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
