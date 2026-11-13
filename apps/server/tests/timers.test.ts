import { createGame, getAwaitedPlayers, getLegalMoves, type GameState } from '@durak/game-engine';
import type { GameMode } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/domain/types.js';
import { abandonThreshold, stepOnTimeout } from '../src/services/timeoutPolicy.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';

type Ctx = ReturnType<typeof setupServices>;

async function startedGame(ctx: Ctx, players = 2): Promise<{ roomId: string; sessions: Session[] }> {
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'p0', maxPlayers: players }, noBind));
  const sessions = [host];
  for (let i = 1; i < players; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `p${i}`, noBind)));
  await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, sessions };
}

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room || !game) throw new Error('missing room/game');
  return { room, game };
}

const TURN = 30_000;
const AFK = 5_000;
const GRACE = 60_000;

describe('turn timer', () => {
  it('fires exactly once at the deadline, applies the timeout moves and arms the next deadline', async () => {
    const ctx = setupServices();
    const { roomId } = await startedGame(ctx);
    const start = ctx.time.now();
    expect((await load(ctx, roomId)).game.turnDeadline).toBe(start + TURN);

    await ctx.time.advanceBy(TURN - 1);
    expect((await load(ctx, roomId)).game.version).toBe(0);

    await ctx.time.advanceBy(1);
    const { game } = await load(ctx, roomId);
    expect(game.version).toBe(1);
    expect(game.state.table).toHaveLength(1); // the attacker opened
    expect(game.turnDeadline).toBe(start + 2 * TURN);
    expect(ctx.notifier.of('game').map((e) => e.version)).toEqual([0, 1]);
    expect(ctx.timers.armedCount).toEqual({ turn: 1, grace: 0 });

    await ctx.time.advanceBy(0); // nothing else is due
    expect((await load(ctx, roomId)).game.version).toBe(1);
  });

  it('a stale timer is a no-op: a human move before the deadline wins', async () => {
    const ctx = setupServices();
    const { roomId, sessions } = await startedGame(ctx);
    await ctx.time.advanceBy(10_000);
    const { game } = await load(ctx, roomId);
    const attacker = sessions.find((s) => s.id === game.state.players[game.state.attackerIndex]!.id)!;
    const move = getLegalMoves(game.state, attacker.id)[0]!;
    await unwrap(ctx.games.makeMove(attacker, roomId, move, 0));

    // A timer for version 0 firing late must not apply anything.
    await ctx.timers.handleTurnExpiry(roomId, 0);
    await ctx.time.advanceBy(20_000); // the original deadline passes
    expect((await load(ctx, roomId)).game.version).toBe(1);

    await ctx.time.advanceBy(10_000); // new deadline: human move time + TURN
    expect((await load(ctx, roomId)).game.version).toBe(2);
  });
});

describe('AFK', () => {
  it('two consecutive timeouts flag a player AFK; deadlines shorten only when every awaited player is AFK; a human move clears it', async () => {
    const ctx = setupServices();
    const { roomId, sessions } = await startedGame(ctx);

    let afkPlayer: string | undefined;
    for (let i = 0; i < 10 && !afkPlayer; i++) {
      await ctx.time.advanceBy(TURN);
      const { room, game } = await load(ctx, roomId);
      for (const m of room.members) expect(m.afk).toBe(m.consecutiveTimeouts >= 2);
      const awaited = getAwaitedPlayers(game.state);
      const allAfk = awaited.every((id) => room.members.find((m) => m.playerId === id)!.afk);
      expect(game.turnDeadline! - ctx.time.now()).toBe(allAfk ? AFK : TURN);
      afkPlayer = room.members.find((m) => m.afk)?.playerId;
    }
    expect(afkPlayer).toBeDefined();
    const afkEvent = ctx.notifier.of('room').at(-1)!;
    expect(afkEvent.room.members.find((m) => m.playerId === afkPlayer)?.afk).toBe(true);

    // The AFK player acts (if the game is waiting on them) and is cleared.
    for (let i = 0; i < 10; i++) {
      const { game } = await load(ctx, roomId);
      const moves = getLegalMoves(game.state, afkPlayer!);
      if (moves.length > 0) {
        const session = sessions.find((s) => s.id === afkPlayer)!;
        await unwrap(ctx.games.makeMove(session, roomId, moves[0]!, game.version));
        break;
      }
      await ctx.time.advanceBy(AFK);
    }
    const { room, game } = await load(ctx, roomId);
    expect(room.members.find((m) => m.playerId === afkPlayer)).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
    expect(game.timeoutStreak).toBe(0);
  });

  it('session:resume clears AFK and extends a short AFK deadline to a full turn', async () => {
    const ctx = setupServices();
    const { roomId, sessions } = await startedGame(ctx);
    // Make both players AFK.
    for (let i = 0; i < 10; i++) {
      const { room } = await load(ctx, roomId);
      if (room.members.every((m) => m.afk)) break;
      await ctx.time.advanceBy(TURN);
    }
    const before = await load(ctx, roomId);
    expect(before.game.state.phase.kind).not.toBe('finished');
    expect(before.room.members.every((m) => m.afk)).toBe(true);
    expect(before.game.turnDeadline! - ctx.time.now()).toBe(AFK);

    const awaitedId = getAwaitedPlayers(before.game.state)[0]!;
    const session = sessions.find((s) => s.id === awaitedId)!;
    await unwrap(ctx.rooms.resume(session.token, noBind));
    const after = await load(ctx, roomId);
    expect(after.room.members.find((m) => m.playerId === awaitedId)).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
    expect(after.game.turnDeadline! - ctx.time.now()).toBe(TURN);
    expect(after.game.version).toBe(before.game.version);
  });
});

describe('abandon guard', () => {
  it('a 3-player game left to timeouts is abandoned: durak null, endReason abandoned, timers cleared', async () => {
    const ctx = setupServices({ seed: 1 * 104729 + 3 });
    const { roomId } = await startedGame(ctx, 3);
    for (let i = 0; i < 50; i++) {
      const { game } = await load(ctx, roomId);
      if (game.state.phase.kind === 'finished') break;
      await ctx.time.advanceBy(TURN);
    }
    const { room, game } = await load(ctx, roomId);
    expect(game.state.phase).toEqual({ kind: 'finished', durak: null });
    expect(game.endReason).toBe('abandoned');
    expect(game.turnDeadline).toBeNull();
    expect(room.status).toBe('finished');
    expect(ctx.notifier.of('over')).toHaveLength(1);
    expect(ctx.timers.armedCount).toEqual({ turn: 0, grace: 0 });
  });

  it('any human move resets the streak', async () => {
    const ctx = setupServices();
    const { roomId, sessions } = await startedGame(ctx);
    await ctx.time.advanceBy(TURN);
    await ctx.time.advanceBy(TURN);
    const { game } = await load(ctx, roomId);
    expect(game.timeoutStreak).toBe(2);
    const actor = getAwaitedPlayers(game.state)[0]!;
    const move = getLegalMoves(game.state, actor)[0]!;
    await unwrap(ctx.games.makeMove(sessions.find((s) => s.id === actor)!, roomId, move, game.version));
    expect((await load(ctx, roomId)).game.timeoutStreak).toBe(0);
  });

  function newState(players: number, mode: GameMode, seed: number): GameState {
    const created = createGame({ playerIds: Array.from({ length: players }, (_, i) => `p${i}`), seed, config: { mode } });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  for (const mode of ['podkidnoy', 'perevodnoy'] as const) {
    for (const players of [2, 3, 4, 5, 6]) {
      it(`property: ${players} players, ${mode}: timeout-only games always end (normally or abandoned)`, () => {
        for (let seed = 1; seed <= 40; seed++) {
          let state = newState(players, mode, seed * 104729 + players);
          let streak = 0;
          let endReason: string | null = null;
          for (let expiry = 1; state.phase.kind !== 'finished'; expiry++) {
            expect(expiry).toBeLessThanOrEqual(abandonThreshold(newState(players, mode, 1)));
            const step = stepOnTimeout(state, streak);
            if (!step.ok) throw new Error(step.error.message);
            ({ state, streak, endReason } = step.value);
          }
          expect(['normal', 'abandoned']).toContain(endReason);
          if (endReason === 'abandoned') expect(state.phase).toEqual({ kind: 'finished', durak: null });
          expect(state.finishOrder.length + (state.phase.durak === null ? 0 : 1)).toBe(players);
        }
      });
    }
  }
});

describe('reconnection grace', () => {
  const longTurns = { turnTimeoutMs: 10 * 60_000 };

  it('an offline player who does not return forfeits: durak = leaver, endReason forfeit', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await startedGame(ctx);
    const leaver = sessions[1]!;
    await ctx.rooms.markDisconnected(leaver, async () => true);
    const { room } = await load(ctx, roomId);
    expect(room.members.find((m) => m.playerId === leaver.id)).toMatchObject({
      connected: false,
      graceDeadline: ctx.time.now() + GRACE,
    });

    await ctx.time.advanceBy(GRACE - 1);
    expect((await load(ctx, roomId)).game.state.phase.kind).not.toBe('finished');
    await ctx.time.advanceBy(1);

    const after = await load(ctx, roomId);
    expect(after.game.state.phase).toEqual({ kind: 'finished', durak: leaver.id });
    expect(after.game.endReason).toBe('forfeit');
    expect(after.game.turnDeadline).toBeNull();
    expect(after.room.status).toBe('finished');
    expect(ctx.notifier.of('over')).toHaveLength(1);
    expect(ctx.timers.armedCount).toEqual({ turn: 0, grace: 0 });
  });

  it('resuming within the grace window cancels the forfeit', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await startedGame(ctx);
    const leaver = sessions[1]!;
    await ctx.rooms.markDisconnected(leaver, async () => true);
    await ctx.time.advanceBy(GRACE / 2);
    await unwrap(ctx.rooms.resume(leaver.token, noBind));
    expect((await load(ctx, roomId)).room.members.find((m) => m.playerId === leaver.id)).toMatchObject({
      connected: true,
      graceDeadline: null,
    });
    await ctx.time.advanceBy(GRACE * 2);
    expect((await load(ctx, roomId)).game.state.phase.kind).not.toBe('finished');
  });

  it('no grace in the lobby, and an expiring grace never resigns a player who is already out', async () => {
    const lobby = setupServices();
    const host = await unwrap(lobby.rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    const guest = await unwrap(lobby.rooms.joinRoom(host.roomId, 'g', noBind));
    await lobby.rooms.markDisconnected(guest, async () => true);
    expect((await lobby.repos.rooms.get(host.roomId))?.members.find((m) => m.playerId === guest.id)?.graceDeadline).toBeNull();
    expect(lobby.timers.armedCount.grace).toBe(0);

    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await startedGame(ctx, 3);
    const out = sessions[2]!;
    const { room, game } = await load(ctx, roomId);
    const deadline = ctx.time.now() + 1000;
    await ctx.repos.games.save({ ...game, state: { ...game.state, finishOrder: [out.id] } });
    await ctx.repos.rooms.save({
      ...room,
      members: room.members.map((m) => (m.playerId === out.id ? { ...m, connected: false, graceDeadline: deadline } : m)),
    });
    await ctx.timers.handleGraceExpiry(roomId, out.id, deadline);
    const after = await load(ctx, roomId);
    expect(after.game.version).toBe(game.version);
    expect(after.game.state.phase.kind).not.toBe('finished');
    expect(after.room.members.find((m) => m.playerId === out.id)?.graceDeadline).toBeNull();
  });
});
