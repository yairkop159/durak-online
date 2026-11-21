import { describe, expect, it } from 'vitest';
import {
  championsOf,
  ClientEventSchemas,
  scoreGame,
  standings,
  type GameScoringInput,
  type TournamentGameResult,
  type TournamentSeat,
} from '../src/index.js';

const ids = ['a', 'b', 'c', 'd'];
const classic = (over: Partial<GameScoringInput>): GameScoringInput => ({
  gameId: 'g',
  teams: false,
  playerIds: ids,
  finishGroups: [],
  durakId: null,
  forfeits: [],
  ...over,
});
const seat = (playerId: string, over: Partial<TournamentSeat> = {}): TournamentSeat => ({
  playerId,
  nickname: playerId,
  isBot: false,
  left: false,
  ...over,
});

describe('scoreGame (classic: finishing order)', () => {
  it('first out n−1 points, down to the durak 0', () => {
    const r = scoreGame(classic({ finishGroups: [['b'], ['d'], ['a']], durakId: 'c' }));
    expect(r.points).toEqual({ b: 3, d: 2, a: 1, c: 0 });
    expect(r.duraks).toEqual(['c']);
    expect(r.firsts).toEqual(['b']);
  });

  it('players going out together share the average of their places (multiples of 0.5)', () => {
    const r = scoreGame(classic({ finishGroups: [['a', 'b'], ['d']], durakId: 'c' }));
    expect(r.points).toEqual({ a: 2.5, b: 2.5, d: 1, c: 0 });
    expect(r.firsts).toEqual(['a', 'b']);
  });

  it('a draw: the last group shares its places including the last one', () => {
    const r = scoreGame(classic({ finishGroups: [['a'], ['b'], ['c', 'd']], durakId: null }));
    expect(r.points).toEqual({ a: 3, b: 2, c: 0.5, d: 0.5 });
    expect(r.duraks).toEqual([]);
  });

  it('2 players: win 1, durak 0', () => {
    const r = scoreGame(classic({ playerIds: ['a', 'b'], finishGroups: [['b']], durakId: 'a' }));
    expect(r.points).toEqual({ a: 0, b: 1 });
  });

  it('a forfeiter scores 0 and counts as a durak; nobody gets their place', () => {
    // a left (bot took over) and the bot went out first; c is the durak.
    const r = scoreGame(classic({ finishGroups: [['a'], ['b'], ['d']], durakId: 'c', forfeits: ['a'] }));
    expect(r.points).toEqual({ a: 0, b: 2, d: 1, c: 0 });
    expect(r.duraks).toEqual(['a', 'c']);
    expect(r.firsts).toEqual([]);
  });

  it('a resign: the leaver is the durak, everyone else went out together', () => {
    const r = scoreGame(classic({ finishGroups: [['b'], ['a', 'c', 'd']], durakId: 'a', forfeits: ['a'] }));
    expect(r.points).toEqual({ b: 3, c: 1.5, d: 1.5, a: 0 });
    expect(r.duraks).toEqual(['a']);
  });

  it('seats in no group share the places left before the durak (defensive)', () => {
    const r = scoreGame(classic({ finishGroups: [['a']], durakId: 'd' }));
    expect(r.points).toEqual({ a: 3, b: 1.5, c: 1.5, d: 0 });
  });
});

describe('scoreGame (teams)', () => {
  const team = (over: Partial<GameScoringInput>) => classic({ teams: true, ...over });
  it('the durak’s team 0, the other 1', () => {
    const r = scoreGame(team({ durakId: 'b' }));
    expect(r.points).toEqual({ team0: 1, team1: 0 });
    expect(r.duraks).toEqual(['team1']);
    expect(r.firsts).toEqual(['team0']);
  });
  it('a draw: 0.5 each', () => {
    expect(scoreGame(team({ durakId: null })).points).toEqual({ team0: 0.5, team1: 0.5 });
  });
  it('a team with a forfeiter scores 0 even if the other team lost', () => {
    const r = scoreGame(team({ durakId: 'b', forfeits: ['c'] }));
    expect(r.points).toEqual({ team0: 0, team1: 0 });
    expect(r.duraks).toEqual(['team0', 'team1']);
    expect(r.firsts).toEqual([]);
  });
});

const res = (points: Record<string, number>, duraks: string[] = [], firsts: string[] = []): TournamentGameResult => ({
  gameId: Math.random().toString(36),
  points,
  duraks,
  firsts,
});

describe('standings and champions', () => {
  const roster = ['a', 'b', 'c'].map((id) => seat(id));
  it('sums points; tie-break fewer duraks, then more firsts; co-champions when still tied', () => {
    const rows = standings({
      teams: false,
      roster,
      results: [res({ a: 2, b: 1, c: 0 }, ['c'], ['a']), res({ a: 0, b: 1, c: 2 }, ['a'], ['c'])],
    });
    // a: 2 pts, 1 durak, 1 first; b: 2 pts, 0 duraks; c: 2 pts, 1 durak, 1 first.
    expect(rows.map((r) => [r.key, r.points, r.rank])).toEqual([
      ['b', 2, 1],
      ['a', 2, 2],
      ['c', 2, 2],
    ]);
    expect(rows[0]!.lastPoints).toBe(1);
    expect(championsOf(rows)).toEqual(['b']);

    const tied = standings({ teams: false, roster, results: [res({ a: 1, b: 1, c: 0 }, ['c'], ['a', 'b'])] });
    expect(championsOf(tied)).toEqual(['a', 'b']);
  });

  it('a left seat can top the table but never be champion', () => {
    const rows = standings({
      teams: false,
      roster: [seat('a', { left: true, isBot: true }), seat('b'), seat('c')],
      results: [res({ a: 2, b: 1, c: 0 }, ['c'], ['a'])],
    });
    expect(rows[0]!.key).toBe('a');
    expect(rows[0]!.eligible).toBe(false);
    expect(championsOf(rows)).toEqual(['b']);
  });

  it('a bot seat (that never left) can be champion', () => {
    const rows = standings({
      teams: false,
      roster: [seat('bot', { isBot: true }), seat('b'), seat('c')],
      results: [res({ bot: 2, b: 1, c: 0 }, ['c'], ['bot'])],
    });
    expect(championsOf(rows)).toEqual(['bot']);
  });

  it('teams: rows are teams with both partners', () => {
    const rows = standings({
      teams: true,
      roster: ['a', 'b', 'c', 'd'].map((id) => seat(id)),
      results: [res({ team0: 0, team1: 1 }, ['team0'], ['team1'])],
    });
    expect(rows.map((r) => [r.key, r.playerIds])).toEqual([
      ['team1', ['b', 'd']],
      ['team0', ['a', 'c']],
    ]);
    expect(championsOf(rows)).toEqual(['team1']);
  });

  it('before any game everyone is tied at rank 1 with no last points', () => {
    const rows = standings({ teams: false, roster, results: [] });
    expect(rows.every((r) => r.rank === 1 && r.lastPoints === null && r.points === 0)).toBe(true);
  });
});

describe('tournament event schemas', () => {
  it('room:setTournament takes 3, 5, 7 or null', () => {
    const schema = ClientEventSchemas['room:setTournament'];
    for (const games of [3, 5, 7, null]) expect(schema.safeParse({ roomId: 'abcd', games }).success).toBe(true);
    for (const games of [0, 4, 9, '3']) expect(schema.safeParse({ roomId: 'abcd', games }).success).toBe(false);
    expect(schema.safeParse({ roomId: 'abcd', games: 3, extra: 1 }).success).toBe(false);
  });
  it('tournament:next / tournament:end take only a room id', () => {
    for (const ev of ['tournament:next', 'tournament:end'] as const) {
      expect(ClientEventSchemas[ev].safeParse({ roomId: 'abcd' }).success).toBe(true);
      expect(ClientEventSchemas[ev].safeParse({ roomId: 'abcd', x: 1 }).success).toBe(false);
    }
  });
});
