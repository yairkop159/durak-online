import { applyMove } from '@durak/game-engine';
import { describe, expect, it, vi } from 'vitest';
import { RoomSchema, StoredGameSchema, decode, encode } from '../src/repositories/redis/codec.js';
import { makeGame, makeRoom, makeTournamentRoom } from './repositories/fixtures.js';

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

describe('codec: restart votes (Phase 7)', () => {
  it('rooms and games stored before Phase 7 decode with no vote, no cooldowns and an empty gameId', () => {
    const { restartVote: _v, restartCooldowns: _c, ...oldRoom } = makeRoom('room1', 'playing');
    const room = decode(RoomSchema, encode(oldRoom), 'k', log());
    expect(room?.restartVote).toBeNull();
    expect(room?.restartCooldowns).toEqual({});
    const { gameId: _g, ...oldGame } = makeGame('room1');
    expect(decode(StoredGameSchema, encode(oldGame), 'k', log())?.gameId).toBe('');
  });

  it('round-trips an open vote and cooldowns', () => {
    const room = {
      ...makeRoom('room1', 'playing'),
      restartVote: { voteId: 'v1', proposerId: 'p_host', expiresAt: 5, voters: ['p_guest'], accepted: [] },
      restartCooldowns: { p_guest: 99 },
    };
    expect(decode(RoomSchema, encode(room), 'k', log())).toEqual(room);
  });
});

describe('codec: profiles (Phase 10)', () => {
  it('records stored before Phase 10 decode with profileId = null and profiles = {}', () => {
    const room = makeRoom('room1');
    const oldRoom = { ...room, members: room.members.map(({ profileId: _p, ...m }) => m) };
    expect(decode(RoomSchema, encode(oldRoom), 'k', log())?.members.every((m) => m.profileId === null)).toBe(true);
    const { profiles: _p, ...oldGame } = makeGame('room1');
    expect(decode(StoredGameSchema, encode(oldGame), 'k', log())?.profiles).toEqual({});
  });

  it('round-trips profileId and profiles', () => {
    const room = makeRoom('room1');
    const linked = { ...room, members: room.members.map((m) => ({ ...m, profileId: m.isBot ? null : `prof_${m.playerId}` })) };
    expect(decode(RoomSchema, encode(linked), 'k', log())).toEqual(linked);
    const game = makeGame('room1');
    expect(decode(StoredGameSchema, encode(game), 'k', log())?.profiles).toEqual(game.profiles);
  });
});

describe('codec: rating outcome on a finished game', () => {
  it('records stored before it decode with ratings = null', () => {
    const { ratings: _r, ...old } = makeGame('room1', true);
    const logger = log();
    expect(decode(StoredGameSchema, encode(old), 'k', logger)?.ratings).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('round-trips the entries, and a delta that contradicts before/after is rejected (null, logged)', () => {
    const game = makeGame('room1', true);
    expect(decode(StoredGameSchema, encode(game), 'k', log())).toEqual(game);
    const bad = { ...game, ratings: [{ playerId: 'p_host', before: 1000, after: 1016, delta: 3 }] };
    const logger = log();
    expect(decode(StoredGameSchema, encode(bad), 'k', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('codec: team mode', () => {
  it('records stored before it (no teams field) decode unchanged; teams round-trips in room and game config', () => {
    const room = makeRoom('room1');
    const game = makeGame('room1');
    expect(decode(RoomSchema, encode(room), 'k', log())).toEqual(room);
    expect(decode(StoredGameSchema, encode(game), 'k', log())?.state.config).toEqual(game.state.config);
    expect(game.state.config).not.toHaveProperty('teams');

    const teamRoom = { ...room, config: { ...room.config, teams: true } };
    const teamGame = { ...game, state: { ...game.state, config: { ...game.state.config, teams: true } } };
    expect(decode(RoomSchema, encode(teamRoom), 'k', log())).toEqual(teamRoom);
    expect(decode(StoredGameSchema, encode(teamGame), 'k', log())).toEqual(teamGame);
  });

  it('rejects a non-boolean teams flag as a corrupted value', () => {
    const room = makeRoom('room1');
    const logger = log();
    expect(decode(RoomSchema, encode({ ...room, config: { teams: 'yes' } }), 'k', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('codec: tournaments', () => {
  it('a room stored before tournaments decodes with no setup, no series and unknown disconnect times', () => {
    const { tournamentSetup: _s, tournament: _t, ...room } = makeRoom('room1');
    const old = { ...room, members: room.members.map(({ disconnectedAt: _d, ...m }) => m) };
    const logger = log();
    const decoded = decode(RoomSchema, encode(old), 'k', logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(decoded).toEqual(makeRoom('room1'));
  });

  it('a game stored before tournaments decodes with finishGroups = []', () => {
    const { finishGroups: _g, ...old } = makeGame('room1', true);
    expect(decode(StoredGameSchema, encode(old), 'k', log())?.finishGroups).toEqual([]);
  });

  it('round-trips a running series; a bad one is a corrupted value, never a throw', () => {
    const room = makeTournamentRoom('running', 'room1');
    expect(decode(RoomSchema, encode(room), 'k', log())).toEqual(room);
    const logger = log();
    const bad = { ...room, tournament: { ...room.tournament!, gamesPlanned: 4 } };
    expect(decode(RoomSchema, encode(bad), 'k', logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
