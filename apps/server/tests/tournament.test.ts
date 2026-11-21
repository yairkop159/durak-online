import { createGame, type GameState } from '@durak/game-engine';
import { describe, expect, it } from 'vitest';
import type { Room, RoomMember, StoredGame } from '../src/domain/types.js';
import { newBotMember } from '../src/services/RoomService.js';
import { advanceFinishGroups } from '../src/services/gameEvents.js';
import {
  advanceTournament,
  canLeadTournament,
  creditedProfiles,
  finishGroupsOf,
  leadOpenAt,
  newTournament,
  nextGameMembers,
  tournamentChampions,
  tournamentView,
} from '../src/services/tournament.js';

const human = (id: string, over: Partial<RoomMember> = {}): RoomMember => ({
  playerId: id,
  nickname: id.toUpperCase(),
  connected: true,
  isBot: false,
  botDifficulty: null,
  afk: false,
  consecutiveTimeouts: 0,
  graceDeadline: null,
  leftGame: false,
  profileId: `prof_${id}`,
  disconnectedAt: null,
  ...over,
});

function room(members: RoomMember[], over: Partial<Room> = {}): Room {
  return {
    id: 'room1',
    hostId: members[0]!.playerId,
    maxPlayers: members.length,
    config: {},
    members,
    spectators: [],
    status: 'playing',
    createdAt: 0,
    restartVote: null,
    restartCooldowns: {},
    tournamentSetup: { games: 3 },
    tournament: null,
    ...over,
  };
}

function withSeries(r: Room, games: 3 | 5 | 7 = 3): Room {
  return { ...r, tournament: newTournament(r, games, 't1', 100) };
}

let gameCounter = 0;
function finished(
  r: Room,
  groups: string[][],
  durak: string | null,
  over: Partial<StoredGame> = {},
): StoredGame {
  const created = createGame({ playerIds: r.members.map((m) => m.playerId), seed: 1, config: r.config });
  if (!created.ok) throw new Error(created.error.message);
  const state: GameState = {
    ...created.value,
    finishOrder: groups.flat(),
    phase: { kind: 'finished', durak },
  };
  return {
    roomId: r.id,
    gameId: `g${++gameCounter}`,
    seed: 1,
    version: 10,
    state,
    startedAt: 0,
    turnDeadline: null,
    timeoutStreak: 0,
    endReason: 'normal',
    knowledge: {},
    botAssisted: [],
    forfeits: [],
    stats: {},
    profiles: {},
    ratings: null,
    finishGroups: groups,
    ...over,
  };
}

const abc = () => room([human('a'), human('b'), human('c')]);

describe('scoring games into the series', () => {
  it('scores each finished game once (idempotent by gameId) and finishes after N games', () => {
    let r = withSeries(abc());
    const g1 = finished(r, [['a'], ['b']], 'c');
    r = advanceTournament(r, g1, 200);
    const again = advanceTournament(r, g1, 300);
    expect(again).toBe(r);
    expect(r.tournament!.results).toHaveLength(1);
    expect(r.tournament!.results[0]!.points).toEqual({ a: 2, b: 1, c: 0 });

    r = advanceTournament(r, finished(r, [['b'], ['a']], 'c'), 300);
    expect(r.tournament!.status).toBe('running');
    r = advanceTournament(r, finished(r, [['c'], ['a']], 'b'), 400);
    expect(r.tournament!.status).toBe('finished');
    expect(r.tournament!.endedAt).toBe(400);
    expect(tournamentChampions(r.tournament!)).toEqual(['a']); // a: 2+1+1 = 4
    expect(creditedProfiles(r.tournament!)).toEqual(['prof_a']);
    // A finished series takes no more games.
    expect(advanceTournament(r, finished(r, [['b'], ['a']], 'c'), 500)).toBe(r);
  });

  it('restarted and abandoned games count for nothing', () => {
    const r = withSeries(abc());
    for (const endReason of ['restarted', 'abandoned'] as const) {
      expect(advanceTournament(r, finished(r, [['a', 'b', 'c']], null, { endReason }), 200)).toBe(r);
    }
  });

  it('co-champions each get credited', () => {
    let r = withSeries(room([human('a'), human('b')]));
    r = advanceTournament(r, finished(r, [['a']], 'b'), 1);
    r = advanceTournament(r, finished(r, [['b']], 'a'), 2);
    r = advanceTournament(r, finished(r, [['a', 'b']], null), 3);
    expect(tournamentChampions(r.tournament!)).toEqual(['a', 'b']);
    expect(creditedProfiles(r.tournament!)).toEqual(['prof_a', 'prof_b']);
  });

  it('a bot champion is the champion, and then no human is credited', () => {
    let r = withSeries(room([human('a'), human('b'), newBotMember('bot', 'Bot 1', 'hard')]));
    for (let i = 0; i < 3; i++) r = advanceTournament(r, finished(r, [['bot'], ['a']], 'b'), i);
    expect(tournamentChampions(r.tournament!)).toEqual(['bot']);
    expect(creditedProfiles(r.tournament!)).toEqual([]);
  });

  it('teams: team standings; a champion team with a bot partner credits nobody', () => {
    const teams = (m: RoomMember[]) => withSeries(room(m, { config: { teams: true } }));
    let r = teams([human('a'), human('b'), human('c'), human('d')]);
    for (let i = 0; i < 3; i++) r = advanceTournament(r, finished(r, [['a', 'c']], 'b'), i);
    expect(tournamentChampions(r.tournament!)).toEqual(['team0']);
    expect(creditedProfiles(r.tournament!)).toEqual(['prof_a', 'prof_c']);

    let withBot = teams([human('a'), human('b'), newBotMember('x', 'Bot 1', 'easy'), human('d')]);
    for (let i = 0; i < 3; i++) withBot = advanceTournament(withBot, finished(withBot, [['a', 'x']], 'b'), i);
    expect(tournamentChampions(withBot.tournament!)).toEqual(['team0']);
    expect(creditedProfiles(withBot.tournament!)).toEqual([]);
  });
});

describe('departures', () => {
  it('a leaver’s seat is marked left, scores 0 for the forfeit and can never be champion', () => {
    let r = withSeries(room([human('a'), human('b'), human('c')]));
    // a leaves mid-game: the bot takes over and wins every remaining game.
    r = { ...r, members: r.members.map((m) => (m.playerId === 'a' ? { ...m, isBot: true, leftGame: true } : m)) };
    r = advanceTournament(r, finished(r, [['a'], ['b']], 'c', { forfeits: ['a'] }), 1);
    expect(r.tournament!.roster[0]!.left).toBe(true);
    expect(r.tournament!.results[0]!.points.a).toBe(0);
    r = advanceTournament(r, finished(r, [['a'], ['b']], 'c'), 2);
    r = advanceTournament(r, finished(r, [['a'], ['c']], 'b'), 3);
    expect(r.tournament!.status).toBe('finished');
    const view = tournamentView(r, 4)!;
    expect(view.standings[0]!.key).toBe('a'); // tops the table...
    expect(view.standings[0]!.eligible).toBe(false);
    expect(view.champions).toEqual(['b']); // ...but b (1+1+0) is the best eligible seat
  });

  it('fewer than two humans left: ended early, the game that caused it does not count, no champion', () => {
    let r = withSeries(room([human('a'), human('b'), newBotMember('bot', 'Bot 1', 'easy')]));
    r = advanceTournament(r, finished(r, [['a'], ['b']], 'bot'), 1);
    // b leaves; the 2-human series drops to one human.
    const left = { ...r, members: r.members.map((m) => (m.playerId === 'b' ? { ...m, leftGame: true } : m)) };
    const ended = advanceTournament(left, finished(left, [['a'], ['bot']], 'b', { forfeits: ['b'] }), 2);
    expect(ended.tournament!.status).toBe('endedEarly');
    expect(ended.tournament!.endedAt).toBe(2);
    expect(ended.tournament!.results).toHaveLength(1);
    expect(tournamentChampions(ended.tournament!)).toEqual([]);
    expect(creditedProfiles(ended.tournament!)).toEqual([]);
  });

  it('next game: a left human seat that was not taken over becomes a bot seat; AFK resets', () => {
    const members = nextGameMembers([human('a', { leftGame: true }), human('b', { afk: true, consecutiveTimeouts: 2 })]);
    expect(members[0]).toMatchObject({ playerId: 'a', isBot: true, botDifficulty: 'medium', leftGame: true });
    expect(members[1]).toMatchObject({ playerId: 'b', isBot: false, afk: false, consecutiveTimeouts: 0 });
  });
});

describe('who leads between games', () => {
  const between = (members: RoomMember[]) => ({ ...withSeries(room(members)), status: 'finished' as const });

  it('the host always; others only once the host has been offline 60 s', () => {
    const online = between([human('a'), human('b')]);
    expect(canLeadTournament(online, 'a', 0)).toBe(true);
    expect(canLeadTournament(online, 'b', 0)).toBe(false);
    expect(leadOpenAt(online)).toBeNull();

    const away = between([human('a', { connected: false, disconnectedAt: 1_000 }), human('b')]);
    expect(leadOpenAt(away)).toBe(61_000);
    expect(canLeadTournament(away, 'b', 60_999)).toBe(false);
    expect(canLeadTournament(away, 'b', 61_000)).toBe(true);
    // An offline non-host never leads.
    const bothAway = between([human('a', { connected: false, disconnectedAt: 1_000 }), human('b', { connected: false })]);
    expect(canLeadTournament(bothAway, 'b', 100_000)).toBe(false);
  });

  it('a host who is no longer an active human: anyone at once; nobody while a game runs', () => {
    const r = between([human('a', { leftGame: true, isBot: true }), human('b'), human('c')]);
    expect(leadOpenAt(r)).toBe(0);
    expect(canLeadTournament(r, 'c', 0)).toBe(true);
    expect(canLeadTournament({ ...r, status: 'playing' }, 'c', 0)).toBe(false);
  });
});

describe('finish groups', () => {
  it('older games without groups fall back to finishOrder singletons', () => {
    const r = abc();
    const g = finished(r, [['a'], ['b']], 'c', { finishGroups: [] });
    expect(finishGroupsOf(g)).toEqual([['a'], ['b']]);
  });

  it('a step that puts several players out is one group; the durak is never in a group', () => {
    const r = abc();
    const created = createGame({ playerIds: ['a', 'b', 'c'], seed: 3, config: {} });
    if (!created.ok) throw new Error('setup');
    const prev = created.value;
    const next: GameState = { ...prev, finishOrder: ['a', 'b', 'c'], phase: { kind: 'finished', durak: 'c' } };
    expect(advanceFinishGroups([], prev, next)).toEqual([['a', 'b']]);
    expect(advanceFinishGroups([['x']], prev, prev)).toEqual([['x']]);
    expect(r.members).toHaveLength(3);
  });
});
