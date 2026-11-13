import { canonicalActor, sanitizeStateForPlayer } from '@durak/game-engine';
import type { BotDifficulty } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session, StoredGame } from '../src/domain/types.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';
import { chooseMove } from './helpers/viewStrategy.js';

type Ctx = ReturnType<typeof setupServices>;

const STEP = 2_000;
const GRACE = 60_000;
const longTurns = { turnTimeoutMs: 10 * 60_000 };

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room || !game) throw new Error('missing room/game');
  return { room, game };
}

/** `humans` humans (the first is the host) + bot seats, started. */
async function game(ctx: Ctx, humans: number, bots: BotDifficulty[] = []) {
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: humans + bots.length }, noBind));
  const sessions = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind)));
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
    else await ctx.time.advanceBy(STEP);
  }
  throw new Error('game did not finish');
}

describe('leaving a running game', () => {
  it('2 players: the game ends now, the leaver is the durak and is recorded as a forfeit', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2);
    const [host, leaver] = sessions as [Session, Session];
    await unwrap(ctx.rooms.leaveRoom(leaver));

    const { room, game: g } = await load(ctx, roomId);
    expect(g.state.phase).toEqual({ kind: 'finished', durak: leaver.id });
    expect(g.endReason).toBe('forfeit');
    expect(g.forfeits).toEqual([leaver.id]);
    expect(room.status).toBe('finished');
    expect(room.hostId).toBe(host.id);
    expect(room.members.find((m) => m.playerId === leaver.id)).toMatchObject({ leftGame: true, connected: false });
    expect(await ctx.repos.sessions.get(leaver.token)).toBeNull();
    expect(ctx.notifier.of('over')).toHaveLength(1);
    expect(ctx.timers.armedCount).toEqual({ turn: 0, grace: 0 });
  });

  it('3+ players with another human still in: a medium bot takes the seat and the game goes on', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2, ['easy']);
    const [host, guest] = sessions as [Session, Session];
    const before = await load(ctx, roomId);

    await unwrap(ctx.rooms.leaveRoom(host)); // the host leaves: the other human inherits it
    const { room, game: g } = await load(ctx, roomId);
    expect(g.state.phase.kind).not.toBe('finished');
    expect(g.version).toBe(before.game.version + 1);
    expect(g.state).toEqual(before.game.state);
    expect(g.forfeits).toEqual([host.id]);
    expect(g.botAssisted).toEqual([host.id]);
    expect(room.hostId).toBe(guest.id);
    expect(room.members.find((m) => m.playerId === host.id)).toMatchObject({
      nickname: 'h0',
      isBot: true,
      botDifficulty: 'medium',
      leftGame: true,
      connected: true,
    });
    expect(await ctx.repos.sessions.get(host.token)).toBeNull();

    // The bot plays the seat to the end; the leaver stays a forfeit whoever ends up the durak.
    const finished = await playOut(ctx, roomId, [guest]);
    expect(finished.endReason).toBe('normal');
    expect(finished.forfeits).toEqual([host.id]);
  });

  it('3+ players with no other human still in: the game ends and the room is deleted', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 1, ['easy', 'easy']);
    await unwrap(ctx.rooms.leaveRoom(sessions[0]!));
    expect(await ctx.repos.rooms.get(roomId)).toBeNull();
    const over = ctx.notifier.of('over');
    expect(over).toHaveLength(1);
    expect(ctx.timers.armedCount).toEqual({ turn: 0, grace: 0 });
  });

  it('a player who already went out just leaves: nothing changes in the game', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const out = sessions[2]!;
    const { game: g } = await load(ctx, roomId);
    await ctx.repos.games.save({ ...g, state: { ...g.state, finishOrder: [out.id] } });

    await unwrap(ctx.rooms.leaveRoom(out));
    const after = await load(ctx, roomId);
    expect(after.game.version).toBe(g.version);
    expect(after.game.forfeits).toEqual([]);
    expect(after.room.members.find((m) => m.playerId === out.id)).toMatchObject({ leftGame: true, isBot: false });
  });

  it('a rematch frees the seats of players who left', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const [host, guest, leaver] = sessions as [Session, Session, Session];
    await unwrap(ctx.rooms.leaveRoom(leaver));
    await playOut(ctx, roomId, [host, guest]);
    await unwrap(ctx.rooms.rematch(host));
    const room = await ctx.repos.rooms.get(roomId);
    expect(room?.status).toBe('lobby');
    expect(room?.members.map((m) => m.playerId)).toEqual([host.id, guest.id]);
  });
});

describe('reconnection grace expiry follows the same rule', () => {
  it('3+ players with another human still in: bot takeover instead of ending the game', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 3);
    const leaver = sessions[1]!;
    await ctx.rooms.markDisconnected(leaver, async () => true);
    await ctx.time.advanceBy(GRACE);

    const { room, game: g } = await load(ctx, roomId);
    expect(g.state.phase.kind).not.toBe('finished');
    expect(g.forfeits).toEqual([leaver.id]);
    expect(room.members.find((m) => m.playerId === leaver.id)).toMatchObject({ isBot: true, leftGame: true });
    expect(ctx.notifier.of('over')).toHaveLength(0);

    // Coming back late: the seat is no longer theirs.
    expect(await ctx.rooms.resume(leaver.token, noBind)).toMatchObject({ ok: false, error: { code: 'INVALID_SESSION' } });
    expect(await ctx.repos.sessions.get(leaver.token)).toBeNull();
  });

  it('2 players: the game ends with a forfeit (as before) and records the forfeit', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await game(ctx, 2);
    const leaver = sessions[1]!;
    await ctx.rooms.markDisconnected(leaver, async () => true);
    await ctx.time.advanceBy(GRACE);
    const { game: g } = await load(ctx, roomId);
    expect(g.state.phase).toEqual({ kind: 'finished', durak: leaver.id });
    expect(g.endReason).toBe('forfeit');
    expect(g.forfeits).toEqual([leaver.id]);
  });
});
