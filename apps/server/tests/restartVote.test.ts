import type { BotDifficulty } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/domain/types.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';

type Ctx = ReturnType<typeof setupServices>;

const VOTE = 30_000;
const COOLDOWN = 60_000;
const longTurns = { turnTimeoutMs: 10 * 60_000 };

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room || !game) throw new Error('missing room/game');
  return { room, game };
}

async function game(ctx: Ctx, humans: number, bots: BotDifficulty[] = []) {
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: humans + bots.length, config: { mode: 'perevodnoy' } }, noBind));
  const sessions = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind)));
  for (const d of bots) await unwrap(ctx.rooms.addBot(host, d));
  await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, sessions };
}

const ended = (ctx: Ctx) => ctx.notifier.of('voteEnded').map((e) => e.ended);

describe('restart vote', () => {
  it('unanimous accept: the old game ends as restarted and a new game is dealt with the same seats and config', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const [a, b, c] = sessions as [Session, Session, Session];
    const before = await load(ctx, roomId);

    await unwrap(ctx.votes.propose(a));
    const { room: open } = await load(ctx, roomId);
    expect(open.restartVote).toMatchObject({ proposerId: a.id, voters: [b.id, c.id], accepted: [], expiresAt: ctx.time.now() + VOTE });
    const voteId = open.restartVote!.voteId;

    await unwrap(ctx.votes.respond(b, voteId, true));
    expect((await load(ctx, roomId)).room.restartVote?.accepted).toEqual([b.id]);
    await unwrap(ctx.votes.respond(c, voteId, true));

    const { room, game: g } = await load(ctx, roomId);
    expect(room.restartVote).toBeNull();
    expect(room.status).toBe('playing');
    expect(g.version).toBe(0);
    expect(g.gameId).not.toBe(before.game.gameId);
    expect(g.state.players.map((p) => p.id)).toEqual(before.game.state.players.map((p) => p.id));
    expect(g.state.config).toEqual(before.game.state.config);

    const over = ctx.notifier.of('over');
    expect(over).toHaveLength(1);
    expect(over[0]!.game).toMatchObject({ endReason: 'restarted', state: { phase: { kind: 'finished', durak: null } } });
    expect(ended(ctx)).toEqual([{ voteId, proposerId: a.id, outcome: 'passed', by: null }]);
    expect(ctx.votes.armedCount).toBe(0);
    // No cooldown after a vote that passed.
    await unwrap(ctx.votes.propose(a));
  });

  it('one decline cancels it for everyone and puts the proposer on cooldown', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const [a, b] = sessions as [Session, Session, Session];
    await unwrap(ctx.votes.propose(a));
    const voteId = (await load(ctx, roomId)).room.restartVote!.voteId;
    await unwrap(ctx.votes.respond(b, voteId, false));

    const { room, game: g } = await load(ctx, roomId);
    expect(room.restartVote).toBeNull();
    expect(g.version).toBe(0); // the game was not touched (no moves were made)
    expect(ended(ctx)).toEqual([{ voteId, proposerId: a.id, outcome: 'declined', by: b.id }]);

    expect(await ctx.votes.propose(a)).toMatchObject({ ok: false, error: { code: 'VOTE_COOLDOWN' } });
    await ctx.time.advanceBy(COOLDOWN);
    await unwrap(ctx.votes.propose(a));
  });

  it('expires after 30 s without all answers', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2);
    await unwrap(ctx.votes.propose(sessions[0]!));
    await ctx.time.advanceBy(VOTE - 1);
    expect((await load(ctx, roomId)).room.restartVote).not.toBeNull();
    await ctx.time.advanceBy(1);
    expect((await load(ctx, roomId)).room.restartVote).toBeNull();
    expect(ended(ctx).map((e) => e?.outcome)).toEqual(['expired']);
  });

  it('bots never block: against bots only, a proposal passes at once', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 1, ['easy']);
    await unwrap(ctx.votes.propose(sessions[0]!));
    expect(ended(ctx).map((e) => e?.outcome)).toEqual(['passed']);
    expect((await load(ctx, roomId)).game.version).toBe(0);
  });

  it('a disconnected human does not block: going offline mid-vote drops them, which can complete it', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const [a, b, c] = sessions as [Session, Session, Session];
    await ctx.rooms.markDisconnected(c, async () => true); // offline before: not a voter
    await unwrap(ctx.votes.propose(a));
    expect((await load(ctx, roomId)).room.restartVote?.voters).toEqual([b.id]);

    // b goes offline while the vote is open: nobody is left to ask -> passes.
    await ctx.rooms.markDisconnected(b, async () => true);
    expect(ended(ctx).map((e) => e?.outcome)).toEqual(['passed']);
  });

  it('the proposer leaving the game cancels the vote', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const [a] = sessions as [Session, Session, Session];
    await unwrap(ctx.votes.propose(a));
    await unwrap(ctx.rooms.leaveRoom(a)); // 3 players, others human -> bot takeover, game goes on
    expect((await load(ctx, roomId)).room.restartVote).toBeNull();
    expect(ended(ctx).map((e) => e?.outcome)).toEqual(['cancelled']);
  });

  it('one vote at a time; only awaited voters may answer; spectators and bots cannot propose', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2);
    const [a, b] = sessions as [Session, Session];
    const watcher = await unwrap(ctx.rooms.joinRoom(roomId, 'w', noBind));
    expect(await ctx.votes.propose(watcher)).toMatchObject({ ok: false, error: { code: 'NOT_IN_ROOM' } });

    await unwrap(ctx.votes.propose(a));
    expect(await ctx.votes.propose(b)).toMatchObject({ ok: false, error: { code: 'VOTE_IN_PROGRESS' } });
    const voteId = (await load(ctx, roomId)).room.restartVote!.voteId;
    expect(await ctx.votes.respond(a, voteId, true)).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_VOTE' } });
    expect(await ctx.votes.respond(b, 'other', true)).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_VOTE' } });
  });

  it('is refused when no game is running', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, noBind));
    expect(await ctx.votes.propose(host)).toMatchObject({ ok: false, error: { code: 'GAME_NOT_STARTED' } });
  });

  it('a persisted vote is re-armed after a restart and still expires', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2);
    await unwrap(ctx.votes.propose(sessions[0]!));
    ctx.votes.dispose(); // the old process' timers are gone
    expect(await ctx.votes.rearmAll()).toBe(1);
    await ctx.time.advanceBy(VOTE);
    expect((await load(ctx, roomId)).room.restartVote).toBeNull();
    expect(ended(ctx).map((e) => e?.outcome)).toEqual(['expired']);
  });
});
