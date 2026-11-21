import { canonicalActor, sanitizeStateForPlayer } from '@durak/game-engine';
import { losingTeam, teamOfPlayer } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session, StoredGame } from '../src/domain/types.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';
import { chooseMove } from './helpers/viewStrategy.js';

type Ctx = ReturnType<typeof setupServices>;

const STEP = 2_000;
const longTurns = { turnTimeoutMs: 10 * 60_000 };

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room) throw new Error('missing room');
  return { room, game };
}

/** A 4-seat team room: `humans` humans (the first is the host) and medium bots in the rest. */
async function teamRoom(ctx: Ctx, humans: number, opts: { start?: boolean } = {}) {
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: 4, config: { teams: true } }, noBind));
  const sessions = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind)));
  for (let i = humans; i < 4; i++) await unwrap(ctx.rooms.addBot(host, 'medium'));
  if (opts.start ?? true) await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, host, sessions };
}

async function playOut(ctx: Ctx, roomId: string, humans: Session[]): Promise<StoredGame> {
  for (let i = 0; i < 4000; i++) {
    const { game: g } = await load(ctx, roomId);
    if (!g) throw new Error('no game');
    if (g.state.phase.kind === 'finished') return g;
    const human = humans.find((h) => h.id === g.state.players[canonicalActor(g.state)]?.id);
    const move = human ? chooseMove(sanitizeStateForPlayer(g.state, human.id)) : null;
    if (human && move) await unwrap(ctx.games.makeMove(human, roomId, move, g.version));
    else await ctx.time.advanceBy(STEP);
  }
  throw new Error('game did not finish');
}

describe('team mode in the lobby', () => {
  it('room:create refuses teams unless the room has 4 seats', async () => {
    const ctx = setupServices();
    const r = await ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 3, config: { teams: true } }, noBind);
    expect(r.ok ? 'ok' : r.error.code).toBe('TEAMS_NEED_FOUR');
  });

  it('the host toggles teams (4-seat rooms, lobby only); room:state carries it; idempotent', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 4, config: { mode: 'perevodnoy' } }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));

    const byGuest = await ctx.rooms.setTeams(guest, true);
    expect(byGuest.ok ? 'ok' : byGuest.error.code).toBe('NOT_HOST');

    await unwrap(ctx.rooms.setTeams(host, true));
    expect((await load(ctx, host.roomId)).room.config).toEqual({ mode: 'perevodnoy', teams: true });
    await unwrap(ctx.rooms.setTeams(host, true));
    await unwrap(ctx.rooms.setTeams(host, false));
    expect((await load(ctx, host.roomId)).room.config).toEqual({ mode: 'perevodnoy' });

    const small = await unwrap(ctx.rooms.createRoom({ nickname: 'x', maxPlayers: 3 }, noBind));
    const refused = await ctx.rooms.setTeams(small, true);
    expect(refused.ok ? 'ok' : refused.error.code).toBe('TEAMS_NEED_FOUR');
    await unwrap(ctx.rooms.setTeams(small, false)); // turning it off is always fine
  });

  it('the host swaps any two seats (bots too); only the host, only in the lobby', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, host, sessions } = await teamRoom(ctx, 2, { start: false });
    const guest = sessions[1]!;
    const before = (await load(ctx, roomId)).room.members.map((m) => m.playerId);
    expect(before).toHaveLength(4);
    const [h, g, b1, b2] = before as [string, string, string, string];

    // h0 and the guest sit at 0 and 1 (opponents); swapping the guest with the bot at seat 2 makes them partners.
    await unwrap(ctx.rooms.swapSeats(host, g, b1));
    const after = (await load(ctx, roomId)).room.members.map((m) => m.playerId);
    expect(after).toEqual([h, b1, g, b2]);
    expect(teamOfPlayer(after.map((id) => ({ id })), g)).toBe(teamOfPlayer(after.map((id) => ({ id })), h));
    expect(ctx.notifier.of('room').at(-1)!.room!.members.map((m) => m.playerId)).toEqual(after);

    const byGuest = await ctx.rooms.swapSeats(guest, h, g);
    expect(byGuest.ok ? 'ok' : byGuest.error.code).toBe('NOT_HOST');
    const unknown = await ctx.rooms.swapSeats(host, h, 'nobody');
    expect(unknown.ok ? 'ok' : unknown.error.code).toBe('NOT_IN_ROOM');

    await unwrap(ctx.rooms.startGame(host));
    const { game } = await load(ctx, roomId);
    // Seats follow the member order at the deal.
    expect(game!.state.players.map((p) => p.id)).toEqual(after);
    expect(game!.state.config.teams).toBe(true);
    const late = await ctx.rooms.swapSeats(host, h, g);
    expect(late.ok ? 'ok' : late.error.code).toBe('GAME_IN_PROGRESS');
  });

  it('a team game starts only with all four seats filled', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 4, config: { teams: true } }, noBind));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    const r = await ctx.rooms.startGame(host);
    expect(r.ok ? 'ok' : r.error.code).toBe('TEAMS_NEED_FOUR');
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.startGame(host));
  });
});

describe('team games', () => {
  it('me + a bot partner vs 2 bots plays to the end; the durak’s team loses', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await teamRoom(ctx, 1);
    const g = await playOut(ctx, roomId, sessions);
    expect(g.endReason).toBe('normal');
    const durak = g.state.phase.kind === 'finished' ? g.state.phase.durak : undefined;
    if (durak !== null && durak !== undefined) {
      expect(losingTeam(g.state)).toBe(teamOfPlayer(g.state.players, durak));
    }
    // Versions were broadcast in order, once each.
    const versions = ctx.notifier.of('game').map((e) => e.version!);
    versions.forEach((v, i) => expect(v).toBe(i));
  });

  it('a leaver with another human still in: a bot takes the seat, which keeps its team', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await teamRoom(ctx, 2);
    const leaver = sessions[1]!;
    const seatBefore = (await load(ctx, roomId)).game!.state.players.findIndex((p) => p.id === leaver.id);
    await unwrap(ctx.rooms.leaveRoom(leaver));
    const { room, game } = await load(ctx, roomId);
    expect(room.members.find((m) => m.playerId === leaver.id)).toMatchObject({ isBot: true, leftGame: true });
    expect(game!.state.players.findIndex((p) => p.id === leaver.id)).toBe(seatBefore);
    expect(game!.state.config.teams).toBe(true);
    expect(game!.forfeits).toEqual([leaver.id]);
    expect(game!.state.phase.kind).not.toBe('finished');
    const finished = await playOut(ctx, roomId, [sessions[0]!]);
    expect(finished.state.phase.kind).toBe('finished');
  });

  it("the last human leaving resigns: the leaver is the durak and the leaver's team loses", async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, host } = await teamRoom(ctx, 1);
    const { game: before } = await load(ctx, roomId);
    await unwrap(ctx.rooms.leaveRoom(host));
    // The room is deleted with the last human; the finished game went out with game:over.
    const over = ctx.notifier.of('over').at(-1)!.game!;
    expect(over.state.phase).toEqual({ kind: 'finished', durak: host.id });
    expect(over.endReason).toBe('forfeit');
    expect(losingTeam(over.state)).toBe(teamOfPlayer(before!.state.players, host.id));
  });
});
