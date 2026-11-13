import { describe, expect, it } from 'vitest';
import { noBind, setupServices as setup, unwrap } from './helpers/serviceHarness.js';

describe('RoomService', () => {
  it('seats players until the room is full, then adds spectators', async () => {
    const { rooms, repos } = setup();
    const host = await unwrap(rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, noBind));
    const guest = await unwrap(rooms.joinRoom(host.roomId, 'g', noBind));
    const watcher = await unwrap(rooms.joinRoom(host.roomId, 'w', noBind));
    expect(host.role).toBe('player');
    expect(guest.role).toBe('player');
    expect(watcher.role).toBe('spectator');
    const room = await repos.rooms.get(host.roomId);
    expect(room?.members).toHaveLength(2);
    expect(room?.spectators).toHaveLength(1);
    expect(host.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('only the host can start, and only with at least two players', async () => {
    const { rooms } = setup();
    const host = await unwrap(rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    expect(await rooms.startGame(host)).toMatchObject({ ok: false, error: { code: 'NOT_ENOUGH_PLAYERS' } });
    const guest = await unwrap(rooms.joinRoom(host.roomId, 'g', noBind));
    expect(await rooms.startGame(guest)).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    const game = await unwrap(rooms.startGame(host));
    expect(game).toMatchObject({ version: 0, seed: 42 });
    expect(await rooms.startGame(host)).toMatchObject({ ok: false, error: { code: 'GAME_IN_PROGRESS' } });
  });

  it('binds the session before broadcasting so the caller never misses its own update', async () => {
    const { rooms, notifier } = setup();
    const seen: number[] = [];
    await rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, () => seen.push(notifier.events.length));
    expect(seen).toEqual([0]);
    expect(notifier.events.map((e) => e.kind)).toEqual(['room']);
  });

  it('leaving the lobby transfers host; leaving during a game is refused', async () => {
    const { rooms, repos } = setup();
    const host = await unwrap(rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, noBind));
    const guest = await unwrap(rooms.joinRoom(host.roomId, 'g', noBind));
    await unwrap(rooms.leaveRoom(host));
    expect((await repos.rooms.get(host.roomId))?.hostId).toBe(guest.id);
    expect(await repos.sessions.get(host.token)).toBeNull();

    const other = setup();
    const h2 = await unwrap(other.rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, noBind));
    await unwrap(other.rooms.joinRoom(h2.roomId, 'g', noBind));
    await unwrap(other.rooms.startGame(h2));
    expect(await other.rooms.leaveRoom(h2)).toMatchObject({ ok: false, error: { code: 'GAME_IN_PROGRESS' } });
  });
});

describe('GameService', () => {
  async function started() {
    const ctx = setup();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));
    const game = await unwrap(ctx.rooms.startGame(host));
    const attackerId = game.state.players[game.state.attackerIndex]!.id;
    const attacker = attackerId === host.id ? host : guest;
    const defender = attacker === host ? guest : host;
    const card = game.state.players[game.state.attackerIndex]!.hand[0]!;
    return { ...ctx, host, guest, attacker, defender, card };
  }

  it('applies a move for the session player and increments the version', async () => {
    const { games, attacker, card, notifier } = await started();
    const next = await unwrap(games.makeMove(attacker, attacker.roomId, { type: 'attack', card }, 0));
    expect(next.version).toBe(1);
    expect(next.state.table).toHaveLength(1);
    expect(notifier.events.at(-1)).toMatchObject({ kind: 'game', version: 1 });
  });

  it('rejects stale versions without touching the state', async () => {
    const { games, attacker, card, repos } = await started();
    expect(await games.makeMove(attacker, attacker.roomId, { type: 'attack', card }, 5)).toMatchObject({
      ok: false,
      error: { code: 'STALE_STATE' },
    });
    expect((await repos.games.get(attacker.roomId))?.version).toBe(0);
  });

  it('passes engine errors through and rejects non-players', async () => {
    const { games, defender, rooms, host, card } = await started();
    expect(await games.makeMove(defender, defender.roomId, { type: 'take' }, 0)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_MOVE' },
    });
    const watcher = await unwrap(rooms.joinRoom(host.roomId, 'w', noBind));
    expect(watcher.role).toBe('spectator');
    expect(await games.makeMove(watcher, host.roomId, { type: 'attack', card }, 0)).toMatchObject({
      ok: false,
      error: { code: 'NOT_IN_ROOM' },
    });
  });
});

describe('in-memory repositories', () => {
  it('store copies, so callers cannot mutate stored state by aliasing', async () => {
    const { repos, rooms } = setup();
    const host = await unwrap(rooms.createRoom({ nickname: 'h', maxPlayers: 2 }, noBind));
    const room = (await repos.rooms.get(host.roomId)) as unknown as { members: unknown[] };
    room.members.length = 0;
    expect((await repos.rooms.get(host.roomId))?.members).toHaveLength(1);
  });
});
