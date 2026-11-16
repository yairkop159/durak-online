import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameResultInput, ResultSeat } from '../src/ratings/gameResult.js';
import { PrismaProfileStore } from '../src/ratings/PrismaProfileStore.js';
import { PrismaResultStore } from '../src/ratings/PrismaResultStore.js';
import { freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';

const suite = postgresAvailable ? describe : describe.skip;

suite('PrismaResultStore (real Postgres): one transaction, idempotent by gameId', () => {
  let db: TestDatabase;
  let store: PrismaResultStore;
  let n = 0;
  beforeAll(async () => {
    db = await freshDatabase();
    store = new PrismaResultStore(() => db.prisma);
  }, 60_000);
  afterAll(async () => db?.drop());

  const newProfile = async (nickname: string) => (await new PrismaProfileStore(() => db.prisma).create(nickname)).profileId;
  const human = (seat: number, profileId: string | null, over: Partial<ResultSeat> = {}): ResultSeat => ({
    seat,
    playerId: `p${seat}`,
    nickname: `N${seat}`,
    isBot: false,
    profileId,
    botAssisted: false,
    forfeited: false,
    ...over,
  });
  const bot = (seat: number): ResultSeat => human(seat, null, { isBot: true, playerId: `bot${seat}`, nickname: `Bot ${seat}` });
  const result = (seats: ResultSeat[], over: Partial<GameResultInput> = {}): GameResultInput => ({
    gameId: `g${++n}`,
    roomId: 'room1',
    mode: 'podkidnoy',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    endReason: 'normal',
    durakId: null,
    seats,
    ...over,
  });
  const profile = async (id: string) =>
    (await db.query<{ rating: number; games: number; rated_games: number; wins: number; duraks: number; forfeits: number }>(
      'SELECT rating, games, rated_games, wins, duraks, forfeits FROM profiles WHERE id = $1',
      [id],
    ))[0]!;
  const counts = async (gameId: string) => ({
    games: (await db.query('SELECT 1 FROM games WHERE id = $1', [gameId])).length,
    players: (await db.query('SELECT 1 FROM game_players WHERE game_id = $1', [gameId])).length,
  });

  it('writes the game, every seat and the rating changes together', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const input = result([human(0, a), human(1, b), bot(2)], { durakId: 'p1' });
    // The committed changes come back (for game:ratings), rated humans only, in seat order.
    expect(await store.recordGame(input)).toEqual({
      kind: 'recorded',
      ratings: [
        { playerId: 'p0', before: 1000, after: 1016, delta: 16 },
        { playerId: 'p1', before: 1000, after: 984, delta: -16 },
      ],
    });

    expect(await db.query('SELECT mode, player_count, end_reason, rated, bot_assisted, durak_profile_id FROM games WHERE id = $1', [input.gameId])).toEqual([
      { mode: 'podkidnoy', player_count: 3, end_reason: 'normal', rated: true, bot_assisted: false, durak_profile_id: b },
    ]);
    expect(
      await db.query('SELECT seat, profile_id, nickname, is_bot, result, rating_before, rating_after, forfeited, bot_assisted FROM game_players WHERE game_id = $1 ORDER BY seat', [input.gameId]),
    ).toEqual([
      { seat: 0, profile_id: a, nickname: 'N0', is_bot: false, result: 'win', rating_before: 1000, rating_after: 1016, forfeited: false, bot_assisted: false },
      { seat: 1, profile_id: b, nickname: 'N1', is_bot: false, result: 'durak', rating_before: 1000, rating_after: 984, forfeited: false, bot_assisted: false },
      { seat: 2, profile_id: null, nickname: 'Bot 2', is_bot: true, result: 'win', rating_before: null, rating_after: null, forfeited: false, bot_assisted: false },
    ]);
    expect(await profile(a)).toEqual({ rating: 1016, games: 1, rated_games: 1, wins: 1, duraks: 0, forfeits: 0 });
    expect(await profile(b)).toEqual({ rating: 984, games: 1, rated_games: 1, wins: 0, duraks: 1, forfeits: 0 });
  });

  it('recording the same gameId again changes nothing (no double rating on retry)', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const input = result([human(0, a), human(1, b)], { durakId: 'p0' });
    expect(await store.recordGame(input)).toMatchObject({ kind: 'recorded' });
    const before = [await profile(a), await profile(b)];
    expect(await store.recordGame(input)).toEqual({ kind: 'duplicate' });
    expect(await store.recordGame({ ...input, durakId: 'p1' })).toEqual({ kind: 'duplicate' }); // even with different content
    expect([await profile(a), await profile(b)]).toEqual(before);
    expect(await counts(input.gameId)).toEqual({ games: 1, players: 2 });
  });

  it('a failure halfway through leaves no partial rows; a retry then writes everything once', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const input = result([human(0, a), human(1, b)], { durakId: 'p1' });
    const failing = new PrismaResultStore(() => db.prisma, {
      beforeCommit: async () => {
        throw new Error('injected failure after every write');
      },
    });
    await expect(failing.recordGame(input)).rejects.toThrow(/injected/);
    expect(await counts(input.gameId)).toEqual({ games: 0, players: 0 });
    expect(await profile(a)).toMatchObject({ rating: 1000, games: 0 });

    expect(await store.recordGame(input)).toMatchObject({ kind: 'recorded' });
    expect(await counts(input.gameId)).toEqual({ games: 1, players: 2 });
    expect((await profile(a)).rating).toBe(1016);
  });

  it('concurrent games sharing players serialize on the row locks (deterministic overlap)', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const g1 = result([human(0, a), human(1, b)], { durakId: 'p1' }); // A beats B
    const g2 = result([human(0, b), human(1, a)], { durakId: 'p1' }); // B beats A (seats reversed)

    // Hold g1's transaction open after all its writes, then start g2 while g1 still holds the locks.
    let inside!: () => void;
    let release!: () => void;
    const reachedCommit = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    const holding = new PrismaResultStore(() => db.prisma, {
      beforeCommit: async () => {
        inside();
        await gate;
      },
    });
    const first = holding.recordGame(g1);
    await reachedCommit;
    let secondDone = false;
    const second = store.recordGame(g2).then((outcome) => {
      secondDone = true;
      return outcome;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(secondDone).toBe(false); // blocked on g1's FOR UPDATE locks
    release();
    const [o1, o2] = await Promise.all([first, second]);
    expect([o1.kind, o2.kind]).toEqual(['recorded', 'recorded']);
    // The second write's "before" is the first write's "after": read under the lock, after g1 committed.
    // Seats are reversed in g2 (p0 = B, p1 = A).
    const entries = (o: typeof o1) => (o.kind === 'recorded' ? (o.ratings ?? []) : []);
    expect(entries(o1).map((e) => [e.playerId, e.after])).toEqual([['p0', 1016], ['p1', 984]]);
    expect(entries(o2).map((e) => [e.playerId, e.before])).toEqual([['p0', 984], ['p1', 1016]]);

    // Exactly the sequential order g1 → g2: A 1016 → 999, B 984 → 1001 (32 × (1 - E(984 vs 1016)) ≈ 17).
    // Without the locks g2 would have read 1000 / 1000 and both would end at 1000 / 1000.
    expect([(await profile(a)).rating, (await profile(b)).rating]).toEqual([999, 1001]);
    expect(await db.query('SELECT profile_id, rating_before, rating_after FROM game_players WHERE game_id = $1 ORDER BY seat', [g2.gameId])).toEqual([
      { profile_id: b, rating_before: 984, rating_after: 1001 },
      { profile_id: a, rating_before: 1016, rating_after: 999 },
    ]);
  });

  it('2 humans + a bot that is the durak: rated, both deltas 0', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const input = result([human(0, a), bot(1), human(2, b)], { durakId: 'bot1' });
    await store.recordGame(input);
    expect(await profile(a)).toEqual({ rating: 1000, games: 1, rated_games: 1, wins: 1, duraks: 0, forfeits: 0 });
    expect(await profile(b)).toMatchObject({ rating: 1000, rated_games: 1 });
    expect((await db.query('SELECT rated FROM games WHERE id = $1', [input.gameId]))[0]).toEqual({ rated: true });
  });

  it('abandoned / restarted / one human: stored and counted, never rated', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    await store.recordGame(result([human(0, a), human(1, b)], { endReason: 'abandoned' }));
    await store.recordGame(result([human(0, a), human(1, b)], { endReason: 'restarted' }));
    await store.recordGame(result([human(0, a), bot(1)], { durakId: 'p0' }));
    expect(await profile(a)).toEqual({ rating: 1000, games: 3, rated_games: 0, wins: 0, duraks: 1, forfeits: 0 });
    const rows = await db.query('SELECT result, rating_before FROM game_players WHERE profile_id = $1 ORDER BY game_id', [b]);
    expect(rows).toEqual([
      { result: 'unfinished', rating_before: null },
      { result: 'unfinished', rating_before: null },
    ]);
  });

  it('forfeit + bot-assisted are marked; a forfeiter and the durak both lose', async () => {
    const [a, b, c] = [await newProfile('A'), await newProfile('B'), await newProfile('C')];
    const input = result([human(0, a, { forfeited: true, botAssisted: true }), human(1, b), human(2, c)], { durakId: 'p2' });
    await store.recordGame(input);
    expect((await db.query('SELECT bot_assisted FROM games WHERE id = $1', [input.gameId]))[0]).toEqual({ bot_assisted: true });
    expect(await profile(a)).toMatchObject({ rating: 992, forfeits: 1, duraks: 0 });
    expect(await profile(b)).toMatchObject({ rating: 1016, wins: 1 });
    expect(await profile(c)).toMatchObject({ rating: 992, duraks: 1 });
  });

  it('a profile in two seats counts once; a vanished profile is stored as an unprofiled seat', async () => {
    const a = await newProfile('A');
    const input = result([human(0, a), human(1, a), human(2, 'gone'.padEnd(22, 'x'))], { durakId: 'p1' });
    expect(await store.recordGame(input)).toEqual({ kind: 'recorded', ratings: null }); // one profile left: unrated
    expect(await db.query('SELECT seat, profile_id FROM game_players WHERE game_id = $1 ORDER BY seat', [input.gameId])).toEqual([
      { seat: 0, profile_id: a },
      { seat: 1, profile_id: null },
      { seat: 2, profile_id: null },
    ]);
    expect(await profile(a)).toMatchObject({ rating: 1000, games: 1, rated_games: 0 });
  });
});
