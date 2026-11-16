import { RATING_START, ratingEntry } from '@durak/shared';
import { isRated, ratedSeats, ratingsAfter, type GameResultInput } from '../../src/ratings/gameResult.js';
import { RatingsUnavailableError, type RecordOutcome, type ResultStore } from '../../src/ratings/ports.js';

/**
 * A ResultStore that behaves like PrismaResultStore without Postgres: idempotent by gameId, rates
 * with the same pure ELO code, and returns the committed changes. `down` simulates an outage;
 * `hold` keeps the next write "in the transaction" until it resolves.
 */
export class MemoryResultStore implements ResultStore {
  readonly ratings = new Map<string, number>();
  readonly stored = new Set<string>();
  calls = 0;
  down = false;
  hold: Promise<void> | null = null;

  async recordGame(input: GameResultInput): Promise<RecordOutcome> {
    this.calls++;
    if (this.down) throw new RatingsUnavailableError();
    if (this.hold) await this.hold;
    if (this.stored.has(input.gameId)) return { kind: 'duplicate' };
    this.stored.add(input.gameId);
    if (!isRated(input)) return { kind: 'recorded', ratings: null };
    const seats = ratedSeats(input);
    const current = new Map(seats.map((s) => [s.profileId as string, this.ratings.get(s.profileId as string) ?? RATING_START]));
    const after = ratingsAfter(input, current);
    for (const [profileId, rating] of after) this.ratings.set(profileId, rating);
    return {
      kind: 'recorded',
      ratings: seats.map((s) => ratingEntry(s.playerId, current.get(s.profileId as string)!, after.get(s.profileId as string)!)),
    };
  }
}
