import type { PrismaClient } from '../db/database.js';
import { isRated, ratedSeats, ratingsAfter, seatResult, type GameResultInput } from './gameResult.js';
import { RatingsUnavailableError, type RecordOutcome, type ResultStore } from './ports.js';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface PrismaResultStoreOptions {
  /** Test seam: runs inside the transaction after every write, before commit. */
  readonly beforeCommit?: (tx: Tx) => Promise<void>;
}

/**
 * Writes a finished game in ONE interactive transaction:
 * 1. lock the participants' profile rows (`SELECT … ORDER BY id FOR UPDATE`, so two games sharing
 *    players serialize, without deadlocks) and read their current ratings;
 * 2. insert the game with ON CONFLICT DO NOTHING on its gameId: 0 rows → it is already recorded,
 *    nothing else is written (idempotent retries, startup re-submission);
 * 3. insert every seat with its result and rating before/after;
 * 4. update each profile's rating and counters.
 * Any failure rolls the whole game back.
 */
export class PrismaResultStore implements ResultStore {
  constructor(
    private readonly client: () => PrismaClient | null,
    private readonly options: PrismaResultStoreOptions = {},
  ) {}

  async recordGame(input: GameResultInput): Promise<RecordOutcome> {
    const db = this.client();
    if (!db) throw new RatingsUnavailableError();
    return db.$transaction(async (tx) => this.write(tx, input), { maxWait: 5_000, timeout: 15_000 });
  }

  private async write(tx: Tx, input: GameResultInput): Promise<RecordOutcome> {
    const wanted = [...new Set(ratedSeats(input).map((s) => s.profileId as string))].sort();
    const rows =
      wanted.length > 0
        ? await tx.$queryRaw<{ id: string; rating: number }[]>`
            SELECT id, rating FROM profiles WHERE id = ANY(${wanted}) ORDER BY id FOR UPDATE`
        : [];
    const current = new Map(rows.map((r) => [r.id, r.rating]));

    // A profile that no longer exists is stored as an unprofiled seat (never a failing FK).
    const effective: GameResultInput = {
      ...input,
      seats: input.seats.map((s) => (s.profileId !== null && !current.has(s.profileId) ? { ...s, profileId: null } : s)),
    };
    const rated = isRated(effective);
    const after = rated ? ratingsAfter(effective, current) : new Map<string, number>();
    // The first seat of each profile carries it; a second seat of the same profile is unprofiled.
    const profiledSeat = new Map(ratedSeats(effective).map((s) => [s.seat, s.profileId as string]));
    const durakSeat = effective.seats.find((s) => s.playerId === effective.durakId);

    const inserted = await tx.game.createMany({
      data: [
        {
          id: input.gameId,
          roomId: input.roomId,
          mode: input.mode,
          playerCount: input.seats.length,
          endReason: input.endReason,
          rated,
          botAssisted: input.seats.some((s) => s.botAssisted),
          durakProfileId: durakSeat ? (profiledSeat.get(durakSeat.seat) ?? null) : null,
          startedAt: new Date(input.startedAt),
          endedAt: new Date(input.endedAt),
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return 'duplicate';

    await tx.gamePlayer.createMany({
      data: effective.seats.map((seat) => {
        const profileId = profiledSeat.get(seat.seat) ?? null;
        const ratedHere = rated && profileId !== null;
        return {
          gameId: input.gameId,
          seat: seat.seat,
          profileId,
          nickname: seat.nickname,
          isBot: seat.isBot,
          result: seatResult(effective, seat),
          ratingBefore: ratedHere ? (current.get(profileId) ?? null) : null,
          ratingAfter: ratedHere ? (after.get(profileId) ?? null) : null,
          forfeited: seat.forfeited,
          botAssisted: seat.botAssisted,
        };
      }),
    });

    for (const seat of effective.seats) {
      const profileId = profiledSeat.get(seat.seat);
      if (profileId === undefined) continue;
      const result = seatResult(effective, seat);
      const rating = after.get(profileId);
      await tx.profile.update({
        where: { id: profileId },
        data: {
          games: { increment: 1 },
          ...(rated ? { ratedGames: { increment: 1 } } : {}),
          ...(result === 'win' ? { wins: { increment: 1 } } : {}),
          ...(result === 'durak' ? { duraks: { increment: 1 } } : {}),
          ...(result === 'forfeit' ? { forfeits: { increment: 1 } } : {}),
          ...(rating !== undefined ? { rating } : {}),
        },
      });
    }
    if (this.options.beforeCommit) await this.options.beforeCommit(tx);
    return 'recorded';
  }
}
