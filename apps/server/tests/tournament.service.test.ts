import { canonicalActor, sanitizeStateForPlayer } from '@durak/game-engine';
import { TOURNAMENT_HOST_AWAY_MS, type BotDifficulty } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Room, Session, StoredGame } from '../src/domain/types.js';
import { toRoomStatePayload } from '../src/transport/SocketNotifier.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';
import { chooseMove } from './helpers/viewStrategy.js';
import { MemoryResultStore } from './helpers/memoryResultStore.js';

type Ctx = ReturnType<typeof setupServices>;
const longTurns = { turnTimeoutMs: 10 * 60_000 };

async function loadRoom(ctx: Ctx, roomId: string): Promise<Room> {
  const room = await ctx.repos.rooms.get(roomId);
  if (!room) throw new Error('missing room');
  return room;
}

async function loadGame(ctx: Ctx, roomId: string): Promise<StoredGame> {
  const game = await ctx.repos.games.get(roomId);
  if (!game) throw new Error('missing game');
  return game;
}

/** A lobby with `humans` humans (+ bots) and a series of `games` set up, started. */
const prof = (i: number) => `profile${i}`.padEnd(22, 'x');

async function series(ctx: Ctx, humans: number, games: 3 | 5 | 7 = 3, bots: BotDifficulty[] = []) {
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: humans + bots.length, profileId: prof(0) }, noBind));
  const sessions = [host];
  for (let i = 1; i < humans; i++) sessions.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind, prof(i))));
  for (const d of bots) await unwrap(ctx.rooms.addBot(host, d));
  await unwrap(ctx.rooms.setTournament(host, games));
  await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, sessions };
}

/** Plays the running game to its end: humans by a simple strategy, bots and the rest by the clock. */
async function playOut(ctx: Ctx, roomId: string, humans: readonly Session[]): Promise<StoredGame> {
  for (let i = 0; i < 3000; i++) {
    const g = await loadGame(ctx, roomId);
    if (g.state.phase.kind === 'finished') return g;
    const human = humans.find((h) => h.id === g.state.players[canonicalActor(g.state)]?.id);
    const move = human ? chooseMove(sanitizeStateForPlayer(g.state, human.id)) : null;
    if (human && move) await unwrap(ctx.games.makeMove(human, roomId, move, g.version));
    else await ctx.time.advanceBy(2_000);
  }
  throw new Error('game did not finish');
}

const fails = async (p: Promise<{ ok: boolean; error?: { code: string } }>) => {
  const r = await p;
  return r.ok ? 'ok' : r.error!.code;
};

describe('a tournament in one room (services)', () => {
  it('plays N games, scores each once in the game-over write, then crowns a champion', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest] = sessions as [Session, Session, Session];
    const gameIds = new Set<string>();

    for (let n = 1; n <= 3; n++) {
      const g = await playOut(ctx, roomId, sessions);
      gameIds.add(g.gameId);
      const room = await loadRoom(ctx, roomId);
      expect(room.status).toBe('finished');
      expect(room.tournament!.results.map((r) => r.gameId)).toEqual([...gameIds]);
      // The game-over broadcast already carries the score (same write as the finished game).
      const over = ctx.notifier.of('room').at(-1)!.room;
      expect(over.tournament!.results).toHaveLength(n);
      if (n < 3) {
        expect(room.tournament!.status).toBe('running');
        expect(await fails(ctx.rooms.rematch(guest))).toBe('TOURNAMENT_IN_PROGRESS');
        expect(await fails(ctx.rooms.tournamentNext(guest))).toBe('NOT_HOST');
        await unwrap(ctx.rooms.tournamentNext(host));
        const next = await loadGame(ctx, roomId);
        expect(next.version).toBe(0);
        expect(next.state.players.map((p) => p.id)).toEqual(room.members.map((m) => m.playerId));
      }
    }
    const final = await loadRoom(ctx, roomId);
    expect(final.tournament!.status).toBe('finished');
    const view = toRoomStatePayload(final, ctx.time.now()).tournament!;
    expect(view.gamesPlayed).toBe(3);
    expect(view.champions.length).toBeGreaterThan(0);
    // Every game hands out 0+1+2 points; points sum to 9 over 3 games.
    expect(view.standings.reduce((s, r) => s + r.points, 0)).toBe(9);
    expect(await fails(ctx.rooms.tournamentNext(host))).toBe('NO_TOURNAMENT');
    // Back to the lobby clears the series and keeps the setting.
    await unwrap(ctx.rooms.rematch(host));
    const lobby = await loadRoom(ctx, roomId);
    expect(lobby.tournament).toBeNull();
    expect(lobby.tournamentSetup).toEqual({ games: 3 });
  });

  it('a reload mid-series and a spectator get the same table in room:state', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 2, 3);
    await playOut(ctx, roomId, sessions);
    const expected = toRoomStatePayload(await loadRoom(ctx, roomId), 0).tournament!;

    await ctx.rooms.markDisconnected(sessions[1]!, async () => true);
    await unwrap(ctx.rooms.resume(sessions[1]!.token, noBind));
    const resumed = toRoomStatePayload(ctx.notifier.of('room').at(-1)!.room, 0).tournament!;
    expect(resumed.standings).toEqual(expected.standings);

    const spectator = await unwrap(ctx.rooms.joinRoom(roomId, 'watcher', noBind));
    expect(spectator.role).toBe('spectator');
    const seen = toRoomStatePayload(ctx.notifier.of('room').at(-1)!.room, 0).tournament!;
    expect(seen.standings).toEqual(expected.standings);
    expect(JSON.stringify(seen)).not.toContain('profile');
  });

  it('a series needs two humans', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: 2 }, noBind));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.setTournament(host, 5));
    expect(await fails(ctx.rooms.startGame(host))).toBe('TOURNAMENT_NEEDS_HUMANS');
    await unwrap(ctx.rooms.setTournament(host, null));
    await unwrap(ctx.rooms.startGame(host)); // a single game is fine
  });

  it('room:setTournament is host-only and lobby-only', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: 2 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));
    expect(await fails(ctx.rooms.setTournament(guest, 3))).toBe('NOT_HOST');
    await unwrap(ctx.rooms.setTournament(host, 7));
    await unwrap(ctx.rooms.startGame(host));
    expect(await fails(ctx.rooms.setTournament(host, 3))).toBe('GAME_IN_PROGRESS');
  });
});

describe('departures during a series', () => {
  it('a leave between games keeps the seat; a bot plays it in the next game; it can never win', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest, third] = sessions as [Session, Session, Session];
    await playOut(ctx, roomId, sessions);
    await unwrap(ctx.rooms.leaveRoom(guest));
    let room = await loadRoom(ctx, roomId);
    expect(room.members.map((m) => m.playerId)).toEqual(sessions.map((s) => s.id));
    expect(room.tournament!.roster.find((s) => s.playerId === guest.id)!.left).toBe(true);
    expect(room.tournament!.status).toBe('running');

    await unwrap(ctx.rooms.tournamentNext(host));
    room = await loadRoom(ctx, roomId);
    expect(room.members.find((m) => m.playerId === guest.id)).toMatchObject({ isBot: true, leftGame: true });
    await playOut(ctx, roomId, [host, third]);
    const view = toRoomStatePayload(await loadRoom(ctx, roomId), 0).tournament!;
    expect(view.standings.find((r) => r.key === guest.id)!.eligible).toBe(false);
  });

  it('a leave mid-game (bot takeover) scores 0 for that game; the series goes on', async () => {
    const ctx = setupServices({ settings: longTurns, bots: { afkTakeover: true } });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest, third] = sessions as [Session, Session, Session];
    await unwrap(ctx.rooms.leaveRoom(guest));
    const g = await playOut(ctx, roomId, [host, third]);
    expect(g.forfeits).toEqual([guest.id]);
    const room = await loadRoom(ctx, roomId);
    expect(room.tournament!.results[0]!.points[guest.id]).toBe(0);
    expect(room.tournament!.results[0]!.duraks).toContain(guest.id);
    expect(room.tournament!.status).toBe('running');
  });

  it('below two humans the series ends early mid-game: that game does not count, no champion', async () => {
    const closed: Room[] = [];
    const ctx = setupServices({ settings: longTurns, onTournamentClosed: (r) => closed.push(r) });
    const { roomId, sessions } = await series(ctx, 2, 3);
    await playOut(ctx, roomId, sessions);
    await unwrap(ctx.rooms.tournamentNext(sessions[0]!));
    // 2 humans: a leave in the running game ends it (forfeit) and the series with it, in one commit.
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    const room = await loadRoom(ctx, roomId);
    expect(room.tournament!.status).toBe('endedEarly');
    expect(room.tournament!.results).toHaveLength(1);
    expect(toRoomStatePayload(room, 0).tournament!.champions).toEqual([]);
    expect(closed.map((r) => r.tournament!.status)).toEqual(['endedEarly']);
  });

  it('a leave between games that drops below two humans ends the series and reports it once', async () => {
    const closed: Room[] = [];
    const ctx = setupServices({ settings: longTurns, onTournamentClosed: (r) => closed.push(r) });
    const { roomId, sessions } = await series(ctx, 2, 3);
    await playOut(ctx, roomId, sessions);
    await unwrap(ctx.rooms.leaveRoom(sessions[1]!));
    const room = await loadRoom(ctx, roomId);
    expect(room.tournament!.status).toBe('endedEarly');
    expect(room.members).toHaveLength(2); // the seat is kept
    expect(closed).toHaveLength(1);
    // Ending is a lead action only while the series runs.
    expect(await fails(ctx.rooms.tournamentEnd(sessions[0]!))).toBe('NO_TOURNAMENT');
    expect(closed).toHaveLength(1);
  });

  it('the final game reports the closed series once, from the commit', async () => {
    const closed: Room[] = [];
    const ctx = setupServices({ settings: longTurns, onTournamentClosed: (r) => closed.push(r) });
    const { roomId, sessions } = await series(ctx, 2, 3);
    for (let n = 0; n < 3; n++) {
      await playOut(ctx, roomId, sessions);
      if (n < 2) await unwrap(ctx.rooms.tournamentNext(sessions[0]!));
    }
    expect(closed.map((r) => r.tournament!.status)).toEqual(['finished']);
  });
});

describe('host away between games', () => {
  it('others may lead only after the host has been offline 60 s; the host always', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest] = sessions as [Session, Session, Session];
    await playOut(ctx, roomId, sessions);
    await ctx.rooms.markDisconnected(host, async () => true);
    const room = await loadRoom(ctx, roomId);
    const view = toRoomStatePayload(room, ctx.time.now()).tournament!;
    expect(view.leadOpenAt).toBe(ctx.time.now() + TOURNAMENT_HOST_AWAY_MS);

    await ctx.time.advanceBy(TOURNAMENT_HOST_AWAY_MS - 1_000);
    expect(await fails(ctx.rooms.tournamentNext(guest))).toBe('NOT_HOST');
    expect(await fails(ctx.rooms.tournamentEnd(guest))).toBe('NOT_HOST');
    await ctx.time.advanceBy(1_000);
    await unwrap(ctx.rooms.tournamentNext(guest));
    expect((await loadGame(ctx, roomId)).version).toBe(0);
  });

  it('the host coming back closes it again; a host who leaves is replaced at once', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest, third] = sessions as [Session, Session, Session];
    await playOut(ctx, roomId, sessions);
    await ctx.rooms.markDisconnected(host, async () => true);
    await unwrap(ctx.rooms.resume(host.token, noBind));
    await ctx.time.advanceBy(TOURNAMENT_HOST_AWAY_MS * 2);
    expect(await fails(ctx.rooms.tournamentNext(guest))).toBe('NOT_HOST');

    await unwrap(ctx.rooms.leaveRoom(host));
    const room = await loadRoom(ctx, roomId);
    expect(room.hostId).toBe(guest.id); // the existing host-transfer rule
    expect(await fails(ctx.rooms.tournamentNext(third))).toBe('NOT_HOST');
    await unwrap(ctx.rooms.tournamentEnd(guest));
    expect((await loadRoom(ctx, roomId)).tournament!.status).toBe('endedEarly');
  });
});

describe('restart vote in a series', () => {
  it('needs every human: an offline voter is not dropped, so the vote expires', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 3, 3);
    const [host, guest, third] = sessions as [Session, Session, Session];
    await ctx.rooms.markDisconnected(third, async () => true);
    await unwrap(ctx.votes.propose(host));
    let room = await loadRoom(ctx, roomId);
    expect(room.restartVote!.voters).toEqual([guest.id, third.id]);
    await unwrap(ctx.votes.respond(guest, room.restartVote!.voteId, true));
    room = await loadRoom(ctx, roomId);
    expect(room.restartVote).not.toBeNull(); // still waiting for the offline player
    await ctx.time.advanceBy(31_000);
    expect(ctx.notifier.of('voteEnded').at(-1)!.ended!.outcome).toBe('expired');
  });

  it('a unanimous restart replays the game: it counts for nothing', async () => {
    const ctx = setupServices({ settings: longTurns });
    const { roomId, sessions } = await series(ctx, 2, 3);
    const before = await loadGame(ctx, roomId);
    await unwrap(ctx.votes.propose(sessions[0]!));
    const vote = (await loadRoom(ctx, roomId)).restartVote!;
    await unwrap(ctx.votes.respond(sessions[1]!, vote.voteId, true));
    const after = await loadGame(ctx, roomId);
    expect(after.gameId).not.toBe(before.gameId);
    const room = await loadRoom(ctx, roomId);
    expect(room.tournament!.results).toHaveLength(0);
    expect(room.tournament!.status).toBe('running');
  });

  it('outside a series the old rule holds: an offline voter is dropped and the vote passes', async () => {
    const ctx = setupServices({ settings: longTurns });
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: 2 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));
    await unwrap(ctx.rooms.startGame(host));
    await ctx.rooms.markDisconnected(guest, async () => true);
    await unwrap(ctx.votes.propose(host));
    expect(ctx.notifier.of('voteEnded').at(-1)!.ended!.outcome).toBe('passed');
  });
});

describe('the series result reaches the match history (through the result queue)', () => {
  it('a finished series is queued once, after its last game; a re-submission is a duplicate', async () => {
    const store = new MemoryResultStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await series(ctx, 2, 3);
    for (let n = 0; n < 3; n++) {
      await playOut(ctx, roomId, sessions);
      if (n < 2) await unwrap(ctx.rooms.tournamentNext(sessions[0]!));
    }
    await ctx.time.advanceBy(0);
    expect(store.stored.size).toBe(3);
    expect([...store.tournaments.values()].map((t) => [t.status, t.gamesPlayed])).toEqual([['finished', 3]]);
    const credited = [...store.tournamentsWon.keys()];
    expect(credited.length).toBeGreaterThan(0);
    expect(credited.every((id) => [prof(0), prof(1)].includes(id))).toBe(true);

    expect(await ctx.recorder!.resubmitFinished(ctx.repos)).toBeGreaterThan(0);
    await ctx.time.advanceBy(0);
    expect(store.tournaments.size).toBe(1);
    expect([...store.tournamentsWon.values()].every((v) => v === 1)).toBe(true);
  });

  it('an early end (host ends it between games) is stored with no champion', async () => {
    const store = new MemoryResultStore();
    const ctx = setupServices({ settings: longTurns, results: store });
    const { roomId, sessions } = await series(ctx, 2, 5);
    await playOut(ctx, roomId, sessions);
    await unwrap(ctx.rooms.tournamentEnd(sessions[0]!));
    await ctx.time.advanceBy(0);
    const stored = [...store.tournaments.values()];
    expect(stored.map((t) => t.status)).toEqual(['endedEarly']);
    expect(stored[0]!.seats.some((s) => s.champion)).toBe(false);
    expect(store.tournamentsWon.size).toBe(0);
  });
});
