import { describe, expect, it } from 'vitest';
import {
  CreateRoomPayloadSchema,
  DEFAULT_GAME_CONFIG,
  GameConfigSchema,
  losingTeam,
  partnerOf,
  seatsAreOpponents,
  SetTeamsPayloadSchema,
  SwapSeatsPayloadSchema,
  teamOfPlayer,
  teamOfSeat,
  type GamePhase,
} from '../src/index.js';

const players = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
const teams = { teams: true };

describe('team helpers', () => {
  it('teams follow seats: 0+2 vs 1+3', () => {
    expect([0, 1, 2, 3].map(teamOfSeat)).toEqual([0, 1, 0, 1]);
    expect(teamOfPlayer(players, 'c')).toBe(0);
    expect(teamOfPlayer(players, 'd')).toBe(1);
    expect(teamOfPlayer(players, 'zz')).toBeNull();
  });

  it('the partner sits opposite, only in team mode', () => {
    expect(partnerOf(teams, players, 'a')).toBe('c');
    expect(partnerOf(teams, players, 'd')).toBe('b');
    expect(partnerOf({}, players, 'a')).toBeNull();
    expect(partnerOf(teams, players.slice(0, 3), 'a')).toBeNull();
  });

  it('opponents: different teams in team mode, everyone else otherwise', () => {
    expect(seatsAreOpponents(teams, 0, 2)).toBe(false);
    expect(seatsAreOpponents(teams, 0, 3)).toBe(true);
    expect(seatsAreOpponents({}, 0, 2)).toBe(true);
    expect(seatsAreOpponents({}, 1, 1)).toBe(false);
  });

  it("the losing team is the durak's team; none for a draw or outside team mode", () => {
    const finished = (durak: string | null): GamePhase => ({ kind: 'finished', durak });
    expect(losingTeam({ config: teams, players, phase: finished('d') })).toBe(1);
    expect(losingTeam({ config: teams, players, phase: finished('c') })).toBe(0);
    expect(losingTeam({ config: teams, players, phase: finished(null) })).toBeNull();
    expect(losingTeam({ config: {}, players, phase: finished('d') })).toBeNull();
    expect(losingTeam({ config: teams, players, phase: { kind: 'awaitingAttack' } })).toBeNull();
  });
});

describe('team schemas', () => {
  it('the default config has no teams field (existing configs unchanged)', () => {
    expect(DEFAULT_GAME_CONFIG).toEqual({ mode: 'podkidnoy', firstBoutMaxCards: 5, boutMaxCards: 6 });
    expect(GameConfigSchema.parse({ ...DEFAULT_GAME_CONFIG, teams: true }).teams).toBe(true);
    expect(GameConfigSchema.safeParse({ ...DEFAULT_GAME_CONFIG, teams: 'yes' }).success).toBe(false);
  });

  it('room:create accepts teams only with 4 seats', () => {
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'A', maxPlayers: 4, config: { teams: true } }).success).toBe(true);
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'A', maxPlayers: 3, config: { teams: true } }).success).toBe(false);
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'A', maxPlayers: 6, config: { teams: false } }).success).toBe(true);
  });

  it('room:setTeams and room:swapSeats', () => {
    expect(SetTeamsPayloadSchema.safeParse({ roomId: 'abcd', teams: true }).success).toBe(true);
    expect(SetTeamsPayloadSchema.safeParse({ roomId: 'abcd' }).success).toBe(false);
    expect(SwapSeatsPayloadSchema.safeParse({ roomId: 'abcd', a: 'p1', b: 'p2' }).success).toBe(true);
    expect(SwapSeatsPayloadSchema.safeParse({ roomId: 'abcd', a: 'p1', b: 'p1' }).success).toBe(false);
    expect(SwapSeatsPayloadSchema.safeParse({ roomId: 'abcd', a: 'p1', b: 'p2', x: 1 }).success).toBe(false);
  });
});
