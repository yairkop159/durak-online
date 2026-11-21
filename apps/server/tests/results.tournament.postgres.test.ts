import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room, RoomMember } from '../src/domain/types.js';
import { PrismaProfileStore } from '../src/ratings/PrismaProfileStore.js';
import { PrismaResultStore } from '../src/ratings/PrismaResultStore.js';
import { buildTournamentInput } from '../src/ratings/tournamentResult.js';
import { endTournamentEarly, newTournament } from '../src/services/tournament.js';
import { newBotMember } from '../src/services/RoomService.js';
import { freshDatabase, postgresAvailable, type TestDatabase } from './helpers/postgres.js';

const suite = postgresAvailable ? describe : describe.skip;

const member = (playerId: string, profileId: string | null, over: Partial<RoomMember> = {}): RoomMember => ({
  playerId,
  nickname: playerId.toUpperCase(),
  connected: true,
  isBot: false,
  botDifficulty: null,
  afk: false,
  consecutiveTimeouts: 0,
  graceDeadline: null,
  leftGame: false,
  profileId,
  disconnectedAt: null,
  ...over,
});

let n = 0;
/** A room whose series is over, with the given per-game points. */
function seriesRoom(
  members: RoomMember[],
  games: Record<string, number>[],
  options: { left?: string[]; teams?: boolean; early?: boolean } = {},
): Room {
  const base: Room = {
    id: 'room1',
    hostId: members[0]!.playerId,
    maxPlayers: members.length,
    config: options.teams ? { teams: true } : {},
    members,
    spectators: [],
    status: 'finished',
    createdAt: 0,
    restartVote: null,
    restartCooldowns: {},
    tournamentSetup: { games: 3 },
    tournament: null,
  };
  const t = newTournament(base, 3, `t${++n}`, 1_700_000_000_000);
  const results = games.map((points, i) => ({ gameId: `g${n}_${i}`, points, duraks: [], firsts: [] }));
  const roster = t.roster.map((s) => ({ ...s, left: options.left?.includes(s.playerId) ?? false }));
  const over = { ...t, roster, results, status: 'finished' as const, endedAt: 1_700_000_900_000 };
  return { ...base, tournament: options.early ? endTournamentEarly({ ...over, status: 'running' }, 1_700_000_900_000) : over };
}

suite('PrismaResultStore.recordTournament (real Postgres)', () => {
  let db: TestDatabase;
  let store: PrismaResultStore;
  beforeAll(async () => {
    db = await freshDatabase();
    store = new PrismaResultStore(() => db.prisma);
  }, 60_000);
  afterAll(async () => db?.drop());

  const newProfile = async (nickname: string) => (await new PrismaProfileStore(() => db.prisma).create(nickname)).profileId;
  const won = async (id: string) =>
    (await db.query<{ tournaments_won: number }>('SELECT tournaments_won FROM profiles WHERE id = $1', [id]))[0]!.tournaments_won;
  const record = async (room: Room) => store.recordTournament(buildTournamentInput(room)!);

  it('co-champions each get a win; a duplicate writes nothing', async () => {
    const [a, b, c] = [await newProfile('A'), await newProfile('B'), await newProfile('C')];
    const room = seriesRoom([member('a', a), member('b', b), member('c', c)], [{ a: 2, b: 1, c: 0 }, { a: 1, b: 2, c: 0 }]);
    expect(await record(room)).toEqual({ kind: 'recorded' });
    expect(await record(room)).toEqual({ kind: 'duplicate' });
    expect([await won(a), await won(b), await won(c)]).toEqual([1, 1, 0]);
    const rows = await db.query<{ seat: number; points: number; rank: number; champion: boolean }>(
      'SELECT seat, points, rank, champion FROM tournament_players WHERE tournament_id = $1 ORDER BY seat',
      [room.tournament!.id],
    );
    expect(rows).toEqual([
      { seat: 0, points: 3, rank: 1, champion: true },
      { seat: 1, points: 3, rank: 1, champion: true },
      { seat: 2, points: 0, rank: 3, champion: false },
    ]);
  });

  it('an early end is stored with no champion and credits nobody', async () => {
    const [a, b] = [await newProfile('A'), await newProfile('B')];
    const room = seriesRoom([member('a', a), member('b', b)], [{ a: 1, b: 0 }], { early: true, left: ['b'] });
    expect(await record(room)).toEqual({ kind: 'recorded' });
    expect(await db.query('SELECT status, games_played FROM tournaments WHERE id = $1', [room.tournament!.id])).toEqual([
      { status: 'endedEarly', games_played: 1 },
    ]);
    expect(await db.query('SELECT count(*)::int AS n FROM tournament_players WHERE tournament_id = $1 AND champion', [room.tournament!.id])).toEqual([{ n: 0 }]);
    expect([await won(a), await won(b)]).toEqual([0, 0]);
  });

  it('a bot champion is stored as the champion and no human is credited', async () => {
    const [a, b] = [await newProfile('A'), await newProfile('B')];
    const room = seriesRoom([member('a', a), member('b', b), newBotMember('bot', 'Bot 1', 'hard')], [{ bot: 2, a: 1, b: 0 }]);
    await record(room);
    expect(await db.query('SELECT seat, is_bot, champion FROM tournament_players WHERE tournament_id = $1 AND champion', [room.tournament!.id])).toEqual([
      { seat: 2, is_bot: true, champion: true },
    ]);
    expect([await won(a), await won(b)]).toEqual([0, 0]);
  });

  it('a "(left)" seat never wins: the best eligible seat does', async () => {
    const [a, b, c] = [await newProfile('A'), await newProfile('B'), await newProfile('C')];
    const room = seriesRoom([member('a', a), member('b', b), member('c', c)], [{ a: 2, b: 1, c: 0 }], { left: ['a'] });
    await record(room);
    expect([await won(a), await won(b), await won(c)]).toEqual([0, 1, 0]);
  });

  it('a profile deleted mid-series is stored as an unprofiled seat; no profiled human → not stored', async () => {
    const [a, b] = [await newProfile('A'), await newProfile('B')];
    const room = seriesRoom([member('a', a), member('b', b)], [{ a: 1, b: 0 }]);
    await db.query('DELETE FROM profiles WHERE id = $1', [a]);
    expect(await record(room)).toEqual({ kind: 'recorded' });
    expect(await db.query('SELECT seat, profile_id, champion FROM tournament_players WHERE tournament_id = $1 ORDER BY seat', [room.tournament!.id])).toEqual([
      { seat: 0, profile_id: null, champion: true },
      { seat: 1, profile_id: b, champion: false },
    ]);
    expect(buildTournamentInput(seriesRoom([member('x', null), member('y', null)], [{ x: 1, y: 0 }]))).toBeNull();
  });
});
