import { applyMove } from '@durak/game-engine';
import { describe, expect, it, vi } from 'vitest';
import { RoomSchema, StoredGameSchema, decode, encode } from '../src/repositories/redis/codec.js';
import { makeGame, makeRoom } from './repositories/fixtures.js';

const log = () => ({ error: vi.fn() });

describe('codec: bots (Phase 4b)', () => {
  it('a game stored before 4b (no knowledge, no botAssisted) decodes with {} and []', () => {
    const { knowledge: _k, botAssisted: _b, ...old } = makeGame('room1');
    const logger = log();
    const decoded = decode(StoredGameSchema, encode(old), 'k', logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(decoded?.knowledge).toEqual({});
    expect(decoded?.botAssisted).toEqual([]);
  });

  it('round-trips knowledge and botAssisted', () => {
    const game = makeGame('room1');
    expect(decode(StoredGameSchema, encode(game), 'k', log())).toEqual(game);
  });

  it('a member stored before 4b (isBot false, no botDifficulty) decodes as a human', () => {
    const room = makeRoom('room1');
    const old = { ...room, members: room.members.filter((m) => !m.isBot).map(({ botDifficulty: _d, ...m }) => m) };
    const decoded = decode(RoomSchema, encode(old), 'k', log());
    expect(decoded?.members.every((m) => m.isBot === false && m.botDifficulty === null)).toBe(true);
  });

  it('rejects malformed knowledge as a corrupted value', () => {
    const game = makeGame('room1');
    const logger = log();
    const bad = { ...game, knowledge: { p_host: { viewerId: 'p_host', discard: [6], knownHands: {} } } };
    expect(decode(StoredGameSchema, encode(bad), 'k', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

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

describe('codec: leaving games (Phase 7)', () => {
  it('records stored before Phase 7 decode with leftGame = false and forfeits = []', () => {
    const room = makeRoom('room1');
    const oldRoom = { ...room, members: room.members.map(({ leftGame: _l, ...m }) => m) };
    expect(decode(RoomSchema, encode(oldRoom), 'k', log())?.members.every((m) => m.leftGame === false)).toBe(true);

    const { forfeits: _f, ...oldGame } = makeGame('room1');
    expect(decode(StoredGameSchema, encode(oldGame), 'k', log())?.forfeits).toEqual([]);
  });

  it('round-trips leftGame and forfeits', () => {
    const room = makeRoom('room1');
    const left = { ...room, members: room.members.map((m) => ({ ...m, leftGame: m.playerId === 'p_guest' })) };
    expect(decode(RoomSchema, encode(left), 'k', log())).toEqual(left);
    const game = { ...makeGame('room1'), forfeits: ['p_guest'] };
    expect(decode(StoredGameSchema, encode(game), 'k', log())).toEqual(game);
  });
});
