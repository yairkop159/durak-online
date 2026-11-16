import { describe, expect, it } from 'vitest';
import { RATING_START } from '@durak/shared';
import { eloDeltas, expectedScore } from '../src/ratings/elo.js';
import {
  isRated,
  ratedSeats,
  ratingsAfter,
  seatResult,
  type GameResultInput,
  type ResultSeat,
} from '../src/ratings/gameResult.js';

const p = (profileId: string, rating: number, lost = false) => ({ profileId, rating, lost });

function seat(i: number, over: Partial<ResultSeat> = {}): ResultSeat {
  return {
    seat: i,
    playerId: `p${i}`,
    nickname: `N${i}`,
    isBot: false,
    profileId: `prof${i}`,
    botAssisted: false,
    forfeited: false,
    ...over,
  };
}

function game(seats: ResultSeat[], over: Partial<GameResultInput> = {}): GameResultInput {
  return {
    gameId: 'g1',
    roomId: 'room1',
    mode: 'podkidnoy',
    startedAt: 1,
    endedAt: 2,
    endReason: 'normal',
    durakId: null,
    seats,
    ...over,
  };
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('expectedScore', () => {
  it('is 0.5 for equal ratings and symmetric', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 12);
    expect(expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 12);
  });
});

describe('eloDeltas', () => {
  it('2 players, equal ratings: +16 / -16 (K = 32)', () => {
    const d = eloDeltas([p('a', 1000), p('b', 1000, true)]);
    expect(d.get('a')).toBe(16);
    expect(d.get('b')).toBe(-16);
  });

  it('an upset moves more than an expected result', () => {
    const upset = eloDeltas([p('weak', 1000), p('strong', 1400, true)]);
    const expected = eloDeltas([p('weak', 1000, true), p('strong', 1400)]);
    expect(upset.get('weak')).toBe(29); // 32 * (1 - 1/11)
    expect(upset.get('strong')).toBe(-29);
    expect(expected.get('strong')).toBe(3); // 32 * (1/11)
    expect(expected.get('weak')).toBe(-3);
  });

  it('n players: K/(n-1) per pair, so the durak loses about K in total', () => {
    const d = eloDeltas([p('a', 1000), p('b', 1000), p('c', 1000), p('d', 1000, true)]);
    expect(d.get('d')).toBe(-16); // 3 pairs × 32/3 × 0.5
    for (const id of ['a', 'b', 'c']) expect(d.get(id)).toBe(5); // 32/3 × 0.5 = 5.33 → 5
  });

  it('6 players: winners never play each other', () => {
    const d = eloDeltas([p('a', 1000), p('b', 1300), p('c', 900), p('d', 1000), p('e', 1000), p('f', 1000, true)]);
    expect(d.get('f')).toBeLessThan(0);
    expect(d.get('f')).toBeGreaterThanOrEqual(-32);
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(d.get(id)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(sum(d))).toBeLessThanOrEqual(3); // zero-sum up to rounding
  });

  it('no loser: everyone 0 (a draw, or a bot was the durak)', () => {
    const d = eloDeltas([p('a', 1100), p('b', 900)]);
    expect([...d.values()]).toEqual([0, 0]);
    expect(Object.is(d.get('a'), -0)).toBe(false);
  });

  it('two losers (forfeit + durak) do not play each other', () => {
    const d = eloDeltas([p('w', 1000), p('forf', 1000, true), p('dur', 1000, true)]);
    expect(d.get('w')).toBe(16); // 2 matches × 16 × 0.5
    expect(d.get('forf')).toBe(-8);
    expect(d.get('dur')).toBe(-8);
  });

  it('fewer than 2 players: nothing changes', () => {
    expect(eloDeltas([p('a', 1000, true)]).get('a')).toBe(0);
    expect(eloDeltas([]).size).toBe(0);
  });

  it('never matches a profile against itself', () => {
    expect(() => eloDeltas([p('a', 1000), p('a', 1000, true)])).toThrow(/more than once/);
  });

  it('rounds each player once', () => {
    // 3 players, one loser: each winner gains 16 × 0.5 = 8; durak -16 exactly.
    const d = eloDeltas([p('a', 1000), p('b', 1000), p('c', 1000, true)]);
    expect([d.get('a'), d.get('b'), d.get('c')]).toEqual([8, 8, -16]);
  });
});

describe('seat results', () => {
  it('win / durak / draw / forfeit / unfinished', () => {
    const seats = [seat(0), seat(1), seat(2, { forfeited: true })];
    const g = game(seats, { durakId: 'p1' });
    expect(seats.map((s) => seatResult(g, s))).toEqual(['win', 'durak', 'forfeit']);
    expect(seatResult(game(seats), seats[0]!)).toBe('draw');
    for (const endReason of ['abandoned', 'restarted'] as const) {
      expect(seatResult(game(seats, { endReason }), seats[0]!)).toBe('unfinished');
      expect(seatResult(game(seats, { endReason }), seats[2]!)).toBe('forfeit');
    }
  });

  it('a forfeiter who is also the durak counts as a forfeit (one loss)', () => {
    const s = seat(0, { forfeited: true });
    expect(seatResult(game([s, seat(1)], { endReason: 'forfeit', durakId: 'p0' }), s)).toBe('forfeit');
  });
});

describe('isRated', () => {
  it('needs two profiled humans; bots and unprofiled humans do not count', () => {
    expect(isRated(game([seat(0), seat(1)]))).toBe(true);
    expect(isRated(game([seat(0), seat(1, { isBot: true, profileId: null })]))).toBe(false);
    expect(isRated(game([seat(0), seat(1, { profileId: null })]))).toBe(false);
  });

  it('abandoned and restarted games are not rated; forfeit is', () => {
    expect(isRated(game([seat(0), seat(1)], { endReason: 'abandoned' }))).toBe(false);
    expect(isRated(game([seat(0), seat(1)], { endReason: 'restarted' }))).toBe(false);
    expect(isRated(game([seat(0), seat(1)], { endReason: 'forfeit', durakId: 'p0' }))).toBe(true);
  });

  it('a bot-assisted human is still rated', () => {
    expect(isRated(game([seat(0, { botAssisted: true }), seat(1)]))).toBe(true);
  });

  it('the same profile in two seats counts once (never against itself)', () => {
    const g = game([seat(0), seat(1, { profileId: 'prof0' })]);
    expect(ratedSeats(g).map((s) => s.seat)).toEqual([0]);
    expect(isRated(g)).toBe(false);
  });
});

describe('ratingsAfter', () => {
  const start = (ids: string[]) => new Map(ids.map((id) => [id, RATING_START]));

  it('2 humans: the durak loses 16, the other gains 16', () => {
    const g = game([seat(0), seat(1)], { durakId: 'p1' });
    expect(ratingsAfter(g, start(['prof0', 'prof1']))).toEqual(
      new Map([
        ['prof0', 1016],
        ['prof1', 984],
      ]),
    );
  });

  it('2 humans + bots where a bot is the durak: rated, every delta 0', () => {
    const bot = seat(2, { isBot: true, profileId: null, playerId: 'bot' });
    const g = game([seat(0), seat(1), bot], { durakId: 'bot' });
    expect(isRated(g)).toBe(true);
    expect(ratingsAfter(g, start(['prof0', 'prof1']))).toEqual(
      new Map([
        ['prof0', 1000],
        ['prof1', 1000],
      ]),
    );
  });

  it('forfeit in a 3-human game: the forfeiter and the durak both lose', () => {
    const g = game([seat(0, { forfeited: true, botAssisted: true }), seat(1), seat(2)], { durakId: 'p2' });
    expect(ratingsAfter(g, start(['prof0', 'prof1', 'prof2']))).toEqual(
      new Map([
        ['prof0', 992],
        ['prof1', 1016],
        ['prof2', 992],
      ]),
    );
  });

  it('a draw is rated with no change', () => {
    const g = game([seat(0), seat(1)]);
    expect([...ratingsAfter(g, new Map([['prof0', 1200], ['prof1', 800]])).values()]).toEqual([1200, 800]);
  });

  it('fails loudly when a rated profile has no current rating', () => {
    expect(() => ratingsAfter(game([seat(0), seat(1)]), start(['prof0']))).toThrow(/no rating/);
  });
});
