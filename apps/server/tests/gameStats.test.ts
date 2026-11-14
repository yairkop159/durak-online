import { applyMove, createGame, createRng, getLegalMoves, getPlayersToAct, type GameState } from '@durak/game-engine';
import { EMPTY_PLAYER_STATS, STAT_KEYS, type GameMode, type GameStats } from '@durak/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '../src/domain/types.js';
import { StoredGameSchema, decode, encode } from '../src/repositories/redis/codec.js';
import { fastForwardIfBotsOnly } from '../src/services/GameCommitter.js';
import { gameEvents } from '../src/services/gameEvents.js';
import { addStats, advanceStats, initialStats, statsDelta } from '../src/services/gameStats.js';
import { makeGame } from './repositories/fixtures.js';

const sum = (stats: GameStats, key: (typeof STAT_KEYS)[number]) => Object.values(stats).reduce((n, s) => n + s[key], 0);

describe('end-of-game stats', () => {
  it('statsDelta counts each public event once', () => {
    const delta = statsDelta([
      { type: 'played', by: 'a', card: { suit: 'S', rank: 6 }, role: 'open' },
      { type: 'played', by: 'b', card: { suit: 'S', rank: 7 }, role: 'defend' },
      { type: 'played', by: 'c', card: { suit: 'H', rank: 7 }, role: 'throwIn' },
      { type: 'played', by: 'b', card: { suit: 'C', rank: 7 }, role: 'transfer' },
      { type: 'resolved', outcome: 'taken', defenderId: 'c', pairs: 3, cards: 4 },
      { type: 'wentOut', playerId: 'a' },
    ]);
    expect(delta).toEqual({
      a: { ...EMPTY_PLAYER_STATS, cardsPlayed: 1, boutsAttacked: 1 },
      b: { ...EMPTY_PLAYER_STATS, cardsPlayed: 2, transfers: 1 },
      c: { ...EMPTY_PLAYER_STATS, cardsPlayed: 1, throwIns: 1, boutsDefended: 1, takes: 1, cardsTaken: 4 },
    });
    expect(statsDelta([{ type: 'resolved', outcome: 'beaten', defenderId: 'd', pairs: 2, cards: 4 }])).toEqual({
      d: { ...EMPTY_PLAYER_STATS, boutsDefended: 1, defenses: 1 },
    });
    // Adding to an empty (pre-Phase 8) record works.
    expect(addStats({}, delta)).toEqual(delta);
  });

  it('random full games: the totals match what happened on the table', () => {
    for (const mode of ['podkidnoy', 'perevodnoy'] as GameMode[]) {
      for (const players of [2, 3, 5]) {
        for (let seed = 1; seed <= 4; seed++) {
          const created = createGame({ playerIds: Array.from({ length: players }, (_, i) => `p${i}`), seed: seed * 31 + players, config: { mode } });
          if (!created.ok) throw new Error('setup');
          const rng = createRng(seed);
          let state: GameState = created.value;
          let stats = initialStats(state);
          let plays = 0;
          let opens = 0;
          let throwIns = 0;
          let transfers = 0;
          let resolutions = 0;
          let takenCards = 0;
          for (let step = 0; step < 5000 && state.phase.kind !== 'finished'; step++) {
            const actors = getPlayersToAct(state);
            const moves = getLegalMoves(state, actors[rng.nextInt(actors.length)]!);
            const move = moves[rng.nextInt(moves.length)]!;
            const next = applyMove(state, move);
            if (!next.ok) throw new Error(next.error.code);
            if (move.type === 'attack' || move.type === 'defend' || move.type === 'transfer') plays++;
            if (move.type === 'attack') (state.table.length === 0 ? opens++ : throwIns++);
            if (move.type === 'transfer') transfers++;
            for (const e of gameEvents(state, next.value)) {
              if (e.type === 'resolved') {
                resolutions++;
                if (e.outcome === 'taken') takenCards += e.cards;
              }
            }
            stats = advanceStats(stats, state, next.value);
            state = next.value;
          }
          expect(state.phase.kind).toBe('finished');
          expect(sum(stats, 'cardsPlayed')).toBe(plays);
          expect(sum(stats, 'boutsAttacked')).toBe(opens);
          expect(sum(stats, 'throwIns')).toBe(throwIns);
          expect(sum(stats, 'transfers')).toBe(transfers);
          expect(sum(stats, 'boutsDefended')).toBe(resolutions);
          expect(sum(stats, 'cardsTaken')).toBe(takenCards);
          for (const s of Object.values(stats)) expect(s.defenses + s.takes).toBe(s.boutsDefended);
          expect(Object.keys(stats).sort()).toEqual(state.players.map((p) => p.id).sort());
        }
      }
    }
  });

  it('the bots-only fast-forward accumulates stats move by move', () => {
    const created = createGame({ playerIds: ['b1', 'b2', 'b3'], seed: 9, config: {} });
    if (!created.ok) throw new Error('setup');
    const room = {
      members: ['b1', 'b2', 'b3'].map((id) => ({ playerId: id, isBot: true })),
    } as unknown as Room;
    const result = fastForwardIfBotsOnly(room, created.value, initialStats(created.value));
    expect(result?.state.phase.kind).toBe('finished');
    const stats = result!.stats;
    expect(sum(stats, 'boutsAttacked')).toBe(sum(stats, 'boutsDefended'));
    expect(sum(stats, 'boutsAttacked')).toBeGreaterThan(3);
    expect(sum(stats, 'cardsPlayed')).toBeGreaterThan(0);
  });

  it('codec: a game stored before Phase 8 decodes with stats = {}; stats round-trip', () => {
    const log = { error: vi.fn() };
    const { stats: _s, ...old } = makeGame('room1');
    expect(decode(StoredGameSchema, encode(old), 'k', log)?.stats).toEqual({});
    const game = makeGame('room1');
    expect(decode(StoredGameSchema, encode(game), 'k', log)).toEqual(game);
    const bad = { ...game, stats: { p_host: { ...EMPTY_PLAYER_STATS, cardsTaken: -1 } } };
    expect(decode(StoredGameSchema, encode(bad), 'k', log)).toBeNull();
  });
});
