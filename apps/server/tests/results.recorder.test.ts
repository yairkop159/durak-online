import { canonicalActor, sanitizeStateForPlayer } from '@durak/game-engine';
import type { BotDifficulty } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session, StoredGame } from '../src/domain/types.js';
import { isRated, ratingsAfter, seatResult, type GameResultInput } from '../src/ratings/gameResult.js';
import { RatingsUnavailableError, type RecordOutcome, type ResultStore } from '../src/ratings/ports.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';
import { chooseMove } from './helpers/viewStrategy.js';

/** Captures what reaches the store; can simulate an outage. Idempotent by gameId, like Postgres. */
class CapturingStore implements ResultStore {
  readonly recorded = new Map<string, GameResultInput>();
  calls = 0;
  down = false;
  async recordGame(input: GameResultInput): Promise<RecordOutcome> {
    this.calls++;
    if (this.down) throw new RatingsUnavailableError();
    if (this.recorded.has(input.gameId)) return 'duplicate';
    this.recorded.set(input.gameId, input);
    return 'recorded';
  }
  only(): GameResultInput {
    expect(this.recorded.size).toBe(1);
    return [...this.recorded.values()][0]!;
  }
}

type Ctx = ReturnType<typeof setupServices>;
const longTurns = { turnTimeoutMs: 10 * 60_000 };
const prof = (i: number) => `profile${i}`.padEnd(22, 'x');

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room || !game) throw new Error('missing room/game');
  return { room, game };
}

/** `humans` profiled humans (unless `unprofiled`) + bots, started. */
async function game(ctx: Ctx, humans: number, bots: BotDifficulty[] = [], unprofiled: number[] = []) {
  const profileOf = (i: number) => (unprofiled.includes(i) ? null : prof(i));
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: humans + bots.length, profileId: profileOf(0) }, noBind));
  const sessions = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind, profileOf(i))));
  for (const d of bots) await unwrap(ctx.rooms.addBot(host, d));
  await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, sessions };
}

async function playOut(ctx: Ctx, roomId: string, humans: Session[]): Promise<StoredGame> {
  for (let i = 0; i < 3000; i++) {
    const { game: g } = await load(ctx, roomId);
    if (g.state.phase.kind === 'finished') return g;
    const human = humans.find((h) => h.id === g.state.players[canonicalActor(g.state)]?.id);
    const move = human ? chooseMove(sanitizeStateForPlayer(g.state, human.id)) : null;
    if (human && move) await unwrap(ctx.games.makeMove(human, roomId, move, g.version));
    else await ctx.time.advanceBy(2_000);
  }
  throw new Error('game did not finish');
}

/** Lets the queue's async write run. */
const settle = (ctx: Ctx) => ctx.time.advanceBy(0);

describe('GameResultRecorder (single write path → queue → store)', () => {
  it('a played-out 2-human game is recorded once, rated, with the durak and both profiles', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await game(ctx, 2);
    const g = await playOut(ctx, roomId, sessions);
    await settle(ctx);
    const input = store.only();
    expect(input).toMatchObject({ gameId: g.gameId, roomId, endReason: 'normal', mode: g.state.config.mode });
    expect(input.seats.map((s) => s.profileId)).toEqual(g.state.players.map((p) => (p.id === sessions[0]!.id ? prof(0) : prof(1))));
    expect(input.durakId).toBe(g.state.phase.kind === 'finished' ? g.state.phase.durak : 'x');
    expect(isRated(input)).toBe(true); // two profiled humans, ended normally (a draw is rated too)
    // Announcements without a transition (resume, startup) never record.
    const { room } = await load(ctx, roomId);
    ctx.recorder!.onGameChanged(room, g, null);
    ctx.recorder!.onGameChanged(room, g, g.state);
    await settle(ctx);
    expect(store.calls).toBe(1);
  });

  it('a 2-player leave: forfeit, the leaver forfeited, rated', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { sessions } = await game(ctx, 2);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await settle(ctx);
    const input = store.only();
    expect(input.endReason).toBe('forfeit');
    const leaver = input.seats.find((s) => s.playerId === sessions[1]!.id)!;
    expect(leaver).toMatchObject({ forfeited: true, isBot: false, profileId: prof(1) });
    expect(seatResult(input, leaver)).toBe('forfeit');
    expect(isRated(input)).toBe(true);
    const after = ratingsAfter(input, new Map([[prof(0), 1000], [prof(1), 1000]]));
    expect(after).toEqual(new Map([[prof(0), 1016], [prof(1), 984]]));
  });

  it('a 3-player takeover: the replaced human stays a rated human, marked bot-assisted and forfeited', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store, bots: { afkTakeover: true } });
    const { roomId, sessions } = await game(ctx, 3);
    await unwrap(ctx.rooms.leaveRoom(sessions[2]!));
    expect(store.recorded.size).toBe(0); // the game goes on
    await playOut(ctx, roomId, sessions.slice(0, 2));
    await settle(ctx);
    const input = store.only();
    const leaver = input.seats.find((s) => s.playerId === sessions[2]!.id)!;
    expect(leaver).toMatchObject({ isBot: false, botAssisted: true, forfeited: true, profileId: prof(2) });
    expect(isRated(input)).toBe(true);
  });

  it('abandoned (everyone idle): stored, not rated', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ results: store });
    const { roomId } = await game(ctx, 2);
    for (let i = 0; i < 200 && (await load(ctx, roomId)).game.state.phase.kind !== 'finished'; i++) await ctx.time.advanceBy(30_000);
    await settle(ctx);
    const input = store.only();
    expect(input.endReason).toBe('abandoned');
    expect(isRated(input)).toBe(false);
    expect(input.seats.map((s) => seatResult(input, s))).toEqual(['unfinished', 'unfinished']);
  });

  it('a passed restart vote: the old game is stored as restarted, not rated', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await game(ctx, 2);
    const before = (await load(ctx, roomId)).game;
    await unwrap(ctx.votes.propose(sessions[0]!));
    const voteId = (await load(ctx, roomId)).room.restartVote!.voteId;
    await unwrap(ctx.votes.respond(sessions[1]!, voteId, true));
    await settle(ctx);
    const input = store.only();
    expect(input).toMatchObject({ gameId: before.gameId, endReason: 'restarted', durakId: null });
    expect(isRated(input)).toBe(false);
  });

  it('one profiled human vs bots: stored, never rated; bots are bot seats without profiles', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await game(ctx, 1, ['easy']);
    await playOut(ctx, roomId, sessions);
    await settle(ctx);
    const input = store.only();
    expect(isRated(input)).toBe(false);
    expect(input.seats.find((s) => s.isBot)).toMatchObject({ profileId: null, botAssisted: false });
  });

  it('no profiled human: nothing is stored', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { sessions } = await game(ctx, 2, [], [0, 1]);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await settle(ctx);
    expect(store.calls).toBe(0);
  });
});

describe('a Postgres outage never touches the game', () => {
  it('the game ends normally; the result waits, is retried with backoff and written exactly once', async () => {
    const store = new CapturingStore();
    store.down = true;
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await game(ctx, 2);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await settle(ctx);
    // The game is over for everyone, whatever the store does.
    expect((await load(ctx, roomId)).room.status).toBe('finished');
    expect(ctx.notifier.of('over')).toHaveLength(1);
    expect(store.calls).toBe(1);
    expect(ctx.resultQueue!.size).toBe(1);

    await ctx.time.advanceBy(2_000); // retry 1 (2 s)
    await ctx.time.advanceBy(4_000); // retry 2 (4 s)
    expect(store.calls).toBe(3);
    store.down = false;
    await ctx.time.advanceBy(8_000); // retry 3 succeeds
    expect(store.recorded.size).toBe(1);
    expect(ctx.resultQueue!.size).toBe(0);
    // Re-submission (startup / Postgres back) is a duplicate, never a second rating.
    expect(await ctx.recorder!.resubmitFinished(ctx.repos)).toBe(1);
    await settle(ctx);
    expect(store.recorded.size).toBe(1);

    const calls = store.calls;
    await ctx.time.advanceBy(10 * 60_000);
    expect(store.calls).toBe(calls); // nothing left to retry
  });

  it('known limit: a finished game leaves the game store after 30 min, so re-submission cannot recover it later', async () => {
    const store = new CapturingStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { sessions } = await game(ctx, 2);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await ctx.time.advanceBy(31 * 60_000);
    expect(await ctx.recorder!.resubmitFinished(ctx.repos)).toBe(0);
  });

  it('gives up after an hour of outage', async () => {
    const store = new CapturingStore();
    store.down = true;
    const ctx = setupServices({ settings: longTurns, results: store });
    const { sessions } = await game(ctx, 2);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    await ctx.time.advanceBy(59 * 60_000);
    expect(ctx.resultQueue!.size).toBe(1); // still retrying (backoff capped at 5 min)
    await ctx.time.advanceBy(6 * 60_000); // the first retry past one hour drops it
    expect(ctx.resultQueue!.size).toBe(0);
    store.down = false;
    await ctx.time.advanceBy(10 * 60_000);
    expect(store.recorded.size).toBe(0);
  });
});
