import { describe, expect, it } from 'vitest';
import { eloDeltas, teamEloDeltas, type TeamEloPlayer } from '../src/ratings/elo.js';
import { isLoss, isRated, ratingsAfter, seatResult, type GameResultInput, type ResultSeat } from '../src/ratings/gameResult.js';
import { MemoryResultStore } from './helpers/memoryResultStore.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';

const tp = (profileId: string, rating: number, team: 0 | 1, forfeited = false): TeamEloPlayer => ({ profileId, rating, team, forfeited });

function seat(i: number, over: Partial<ResultSeat> = {}): ResultSeat {
  return { seat: i, playerId: `p${i}`, nickname: `N${i}`, isBot: false, profileId: `prof${i}`, botAssisted: false, forfeited: false, ...over };
}

function teamGame(over: Partial<GameResultInput> = {}, seats: ResultSeat[] = [0, 1, 2, 3].map((i) => seat(i))): GameResultInput {
  return { gameId: 'g1', roomId: 'room1', mode: 'podkidnoy', teams: true, startedAt: 1, endedAt: 2, endReason: 'normal', durakId: 'p1', seats, ...over };
}

describe('team ELO: cross-team pairs only', () => {
  it('equal ratings: each winner gains 2 × K/2 × 0.5 = 16, each loser loses 16; zero-sum', () => {
    const d = teamEloDeltas([tp('a', 1000, 0), tp('b', 1000, 1), tp('c', 1000, 0), tp('d', 1000, 1)], 1);
    expect(Object.fromEntries(d)).toEqual({ a: 16, b: -16, c: 16, d: -16 });
  });

  it("partners are never paired: my delta does not depend on my partner's rating", () => {
    for (const partner of [600, 1000, 1800]) {
      const d = teamEloDeltas([tp('a', 1100, 0), tp('b', 1000, 1), tp('c', partner, 0), tp('d', 1300, 1)], 1);
      expect(d.get('a')).toBe(teamEloDeltas([tp('a', 1100, 0), tp('b', 1000, 1), tp('c', 1000, 0), tp('d', 1300, 1)], 1).get('a'));
    }
  });

  it('a draw with no forfeits changes nothing', () => {
    const d = teamEloDeltas([tp('a', 1200, 0), tp('b', 900, 1), tp('c', 1000, 0), tp('d', 1000, 1)], null);
    expect([...d.values()]).toEqual([0, 0, 0, 0]);
  });

  it('a forfeiter on the WINNING team still loses to both opponents; the opponents gain from it', () => {
    const d = teamEloDeltas([tp('a', 1000, 0, true), tp('b', 1000, 1), tp('c', 1000, 0), tp('d', 1000, 1)], 1);
    expect(d.get('a')).toBeLessThan(0);
    // b and d lost to c (team result) but beat a (the forfeit): net 0.
    expect(d.get('b')).toBe(0);
    expect(d.get('c')).toBe(16);
  });

  it("property: a forfeiter's rating never goes up or stays the same when they have rated opponents", () => {
    const grid = [700, 1000, 1300, 1900, 2600];
    const forfeitSets = [1, 2, 3, 5, 6, 7, 9, 10, 15]; // bitmasks over the four seats, every shape
    let checked = 0;
    for (const forfeits of forfeitSets) {
      for (const losing of [0, 1, null] as const) {
        for (const r0 of grid) for (const r1 of grid) for (const r2 of [800, 2400]) for (const r3 of [1000, 2000]) {
          const players = [r0, r1, r2, r3].map((r, i) => tp(`s${i}`, r, (i % 2) as 0 | 1, ((forfeits >> i) & 1) === 1));
          const d = teamEloDeltas(players, losing);
          for (const p of players) {
            if (p.forfeited) {
              expect(d.get(p.profileId)).toBeLessThan(0);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('throws if a profile appears twice', () => {
    expect(() => teamEloDeltas([tp('a', 1000, 0), tp('a', 1000, 1)], 0)).toThrow();
  });

  it('the classic eloDeltas is unchanged', () => {
    const d = eloDeltas([
      { profileId: 'a', rating: 1000, lost: false },
      { profileId: 'b', rating: 1000, lost: true },
      { profileId: 'c', rating: 1200, lost: false },
    ]);
    expect(Object.fromEntries(d)).toEqual({ a: 8, b: -12, c: 4 });
  });
});

describe('team game results', () => {
  it("the durak's partner gets teamLoss (a loss); the other team wins", () => {
    const input = teamGame();
    expect(input.seats.map((s) => seatResult(input, s))).toEqual(['win', 'durak', 'win', 'teamLoss']);
    expect(isLoss('teamLoss')).toBe(true);
    const after = ratingsAfter(input, new Map(input.seats.map((s) => [s.profileId!, 1000])));
    expect([...after.values()]).toEqual([1016, 984, 1016, 984]);
  });

  it('a forfeit beats the team label; a draw is a draw for everyone', () => {
    const input = teamGame({ durakId: 'p1' }, [seat(0, { forfeited: true }), seat(1), seat(2), seat(3)]);
    expect(input.seats.map((s) => seatResult(input, s))).toEqual(['forfeit', 'durak', 'win', 'teamLoss']);
    const draw = teamGame({ durakId: null });
    expect(draw.seats.map((s) => seatResult(draw, s))).toEqual(['draw', 'draw', 'draw', 'draw']);
  });

  it('rated only with four profiled humans (a takeover still counts as its human)', () => {
    expect(isRated(teamGame())).toBe(true);
    expect(isRated(teamGame({}, [seat(0), seat(1), seat(2), seat(3, { isBot: true, profileId: null })]))).toBe(false);
    expect(isRated(teamGame({}, [seat(0), seat(1), seat(2), seat(3, { profileId: null })]))).toBe(false);
    expect(isRated(teamGame({}, [seat(0), seat(1), seat(2), seat(3, { botAssisted: true, forfeited: true })]))).toBe(true);
    expect(isRated(teamGame({ endReason: 'abandoned' }))).toBe(false);
  });
});

describe('game:ratings for a team game', () => {
  it('a team game without four profiled humans is announced unrated: teamsNeedFourHumans', async () => {
    const ctx = setupServices({ results: new MemoryResultStore(), settings: { turnTimeoutMs: 600_000 } });
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 4, config: { teams: true }, profileId: 'prof-h' }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind, 'prof-g'));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.startGame(host));
    await unwrap(ctx.rooms.leaveRoom(guest)); // a takeover: the game goes on
    await unwrap(ctx.rooms.leaveRoom(host)); // the last human: resign, the game ends
    const statuses = ctx.notifier.of('ratings').map((e) => e.ratings);
    expect(statuses).toContainEqual(expect.objectContaining({ status: 'unrated', reason: 'teamsNeedFourHumans' }));
  });
});
