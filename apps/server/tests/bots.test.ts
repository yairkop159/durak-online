import {
  applyMove,
  canonicalActor,
  createGame,
  getLegalMoves,
  sanitizeStateForPlayer,
  type GameState,
} from '@durak/game-engine';
import { cardId, type BotDifficulty, type Card, type ClientMove } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import type { BotJob, BotRunner } from '../src/bot/job.js';
import { ok } from '../src/domain/result.js';
import type { Room, Session, StoredGame } from '../src/domain/types.js';
import { BotDriver, DEFAULT_BOT_PACING } from '../src/services/BotDriver.js';
import { fastForwardIfBotsOnly } from '../src/services/GameCommitter.js';
import { newBotMember } from '../src/services/RoomService.js';
import { FakeTime } from './helpers/fakeTime.js';
import { noBind, setupServices, unwrap, type ServiceHarnessOptions } from './helpers/serviceHarness.js';
import { chooseMove } from './helpers/viewStrategy.js';

type Ctx = ReturnType<typeof setupServices>;

/** Longest pacing delay with random = 0.5 is 1300 + 250; one step always lets the bot act. */
const STEP = 2_000;
const TURN = 30_000;

async function load(ctx: Ctx, roomId: string) {
  const room = await ctx.repos.rooms.get(roomId);
  const game = await ctx.repos.games.get(roomId);
  if (!room || !game) throw new Error('missing room/game');
  return { room, game };
}

/** Host (human) + `bots` bot seats + `humans - 1` more humans, started. */
async function botGame(
  ctx: Ctx,
  opts: { bots: BotDifficulty[]; humans?: number; start?: boolean },
): Promise<{ roomId: string; humans: Session[]; botIds: string[] }> {
  const humansCount = opts.humans ?? 1;
  const maxPlayers = humansCount + opts.bots.length;
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers }, noBind));
  const humans = [host];
  for (let i = 1; i < humansCount; i++) humans.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind)));
  const botIds: string[] = [];
  for (const d of opts.bots) botIds.push((await unwrap(ctx.rooms.addBot(host, d))).playerId);
  if (opts.start ?? true) await unwrap(ctx.rooms.startGame(host));
  return { roomId: host.roomId, humans, botIds };
}

/**
 * Plays to the end: humans move (from their own view) whenever they are the canonical actor,
 * otherwise time advances so the bots act. Returns the finished game.
 */
async function playOut(ctx: Ctx, roomId: string, humans: Session[], maxSteps = 3000): Promise<StoredGame> {
  for (let i = 0; i < maxSteps; i++) {
    const { game } = await load(ctx, roomId);
    if (game.state.phase.kind === 'finished') return game;
    const actor = canonicalActor(game.state);
    const human = humans.find((h) => h.id === game.state.players[actor]?.id);
    if (human) {
      const move = chooseMove(sanitizeStateForPlayer(game.state, human.id));
      if (move) {
        await unwrap(ctx.games.makeMove(human, roomId, move, game.version));
        continue;
      }
    }
    await ctx.time.advanceBy(STEP);
  }
  throw new Error('game did not finish');
}

function expectConsecutiveVersions(ctx: Ctx): void {
  const versions = ctx.notifier.of('game').map((e) => e.version!);
  versions.forEach((v, i) => expect(v).toBe(i));
}

describe('bot seats in the lobby', () => {
  it('the host adds and removes bots; bots are connected, never AFK, and get Bot N nicknames', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    const b1 = await unwrap(ctx.rooms.addBot(host, 'easy'));
    const b2 = await unwrap(ctx.rooms.addBot(host, 'hard'));
    expect([b1.nickname, b2.nickname]).toEqual(['Bot 1', 'Bot 2']);
    expect(b1).toMatchObject({ isBot: true, botDifficulty: 'easy', connected: true, afk: false, graceDeadline: null });
    expect((await ctx.rooms.addBot(host, 'medium')).ok).toBe(false); // full
    const full = await ctx.rooms.addBot(host, 'medium');
    expect(!full.ok && full.error.code).toBe('ROOM_FULL');

    await unwrap(ctx.rooms.removeBot(host, b1.playerId));
    const again = await unwrap(ctx.rooms.addBot(host, 'medium'));
    expect(again.nickname).toBe('Bot 1');
    const notBot = await ctx.rooms.removeBot(host, host.id);
    expect(!notBot.ok && notBot.error.code).toBe('NOT_A_BOT');
  });

  it('only the host, only in the lobby', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));
    const byGuest = await ctx.rooms.addBot(guest, 'easy');
    expect(!byGuest.ok && byGuest.error.code).toBe('NOT_HOST');
    const bot = await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.startGame(host));
    const late = await ctx.rooms.addBot(host, 'easy');
    expect(!late.ok && late.error.code).toBe('GAME_IN_PROGRESS');
    const lateRemove = await ctx.rooms.removeBot(host, bot.playerId);
    expect(!lateRemove.ok && lateRemove.error.code).toBe('GAME_IN_PROGRESS');
  });

  it('the host passes to a human, never a bot; the last human leaving deletes the room', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 4 }, noBind));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'g', noBind));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.leaveRoom(host));
    expect((await ctx.repos.rooms.get(host.roomId))?.hostId).toBe(guest.id);
    await unwrap(ctx.rooms.leaveRoom(guest));
    expect(await ctx.repos.rooms.get(host.roomId)).toBeNull();
  });

  it('a game cannot start with zero humans', async () => {
    const ctx = setupServices();
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h', maxPlayers: 3 }, noBind));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    await unwrap(ctx.rooms.addBot(host, 'easy'));
    // Force an impossible room (bots only, host id kept) straight into the repository.
    const room = (await ctx.repos.rooms.get(host.roomId))!;
    await ctx.repos.rooms.save({ ...room, members: room.members.filter((m) => m.isBot) });
    const result = await ctx.rooms.startGame(host);
    expect(!result.ok && result.error.code).toBe('NO_HUMANS');
  });
});

describe('BotDriver in games', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    it(`human vs ${difficulty} bot plays to the end; every version is broadcast exactly once`, async () => {
      const ctx = setupServices();
      const { roomId, humans } = await botGame(ctx, { bots: [difficulty] });
      const game = await playOut(ctx, roomId, humans);
      expect(game.state.phase.kind).toBe('finished');
      expect(game.endReason).toBe('normal');
      expectConsecutiveVersions(ctx);
      const applied = ctx.bots.events.filter((e) => e.kind === 'applied');
      expect(applied.length).toBeGreaterThan(0);
      expect(ctx.bots.events.filter((e) => e.kind === 'rejected')).toEqual([]);
      expect(ctx.bots.inFlight).toEqual([]);
      expect(game.botAssisted).toEqual([]);
    });
  }

  it('two bots and a human: no double-applies, every bot move lands on the version it planned for', async () => {
    const ctx = setupServices({ seed: 7 });
    const { roomId, humans } = await botGame(ctx, { bots: ['medium', 'easy'] });
    await playOut(ctx, roomId, humans);
    expectConsecutiveVersions(ctx);
    const applied = ctx.bots.events.filter((e) => e.kind === 'applied');
    // Each applied move took version v -> v + 1: so at most one applied move per planned version.
    const versions = applied.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const e of applied) {
      const next = ctx.notifier.of('game').find((g) => g.version === e.version + 1)!;
      expect(next).toBeDefined();
    }
  });

  it('a human move that lands while the bot is applying makes the bot STALE: dropped silently, re-planned, one bump per move', async () => {
    const ctx = setupServices({ seed: 11 });
    const { roomId, humans } = await botGame(ctx, { bots: ['medium'] });
    const human = humans[0]!;

    // Play until the bot has a decision ready and the human also has a legal move at that version.
    let race: { version: number; move: ClientMove } | null = null;
    for (let i = 0; i < 400 && !race; i++) {
      const { game } = await load(ctx, roomId);
      if (game.state.phase.kind === 'finished') break;
      const entry = ctx.bots.inFlight[0];
      const humanMoves = getLegalMoves(game.state, human.id);
      if (entry?.stage === 'ready' && entry.version === game.version && humanMoves.length > 0) {
        race = { version: game.version, move: toClient(humanMoves[0]!) };
        break;
      }
      const actor = canonicalActor(game.state);
      if (game.state.players[actor]?.id === human.id) {
        const move = chooseMove(sanitizeStateForPlayer(game.state, human.id));
        if (move) {
          await unwrap(ctx.games.makeMove(human, roomId, move, game.version));
          continue;
        }
      }
      await ctx.time.advanceBy(100);
    }
    expect(race).not.toBeNull();
    const { version, move } = race!;

    // Hold the room lock; the bot's apply fires and queues behind it; the human move commits inside.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const humanCommit = ctx.mutex.runExclusive(roomId, async () => {
      await gate;
      const room = (await ctx.repos.rooms.get(roomId))!;
      const game = (await ctx.repos.games.get(roomId))!;
      const applied = applyMove(game.state, { ...move, playerId: human.id });
      if (!applied.ok) throw new Error(applied.error.code);
      await ctx.committer.commit({ room, roomChanged: false, prev: game, state: applied.value, timeoutStreak: 0 });
    });
    const clock = ctx.time.advanceBy(STEP); // fires the bot's apply, which waits for the lock
    await new Promise((r) => setImmediate(r));
    expect(ctx.bots.inFlight.find((e) => e.version === version)?.stage).toBe('applying');
    open();
    await humanCommit;
    await clock;

    const stale = ctx.bots.events.filter((e) => e.kind === 'stale');
    expect(stale.map((e) => e.version)).toEqual([version]);
    const { game } = await load(ctx, roomId);
    expect(game.version).toBeGreaterThanOrEqual(version + 1);
    // The bot re-planned on the new version (or it was not its turn any more).
    const replanned = ctx.bots.events.some((e) => e.kind === 'planned' && e.version === version + 1);
    const botToAct = game.state.players[canonicalActor(game.state)]?.id !== human.id;
    if (botToAct) expect(replanned).toBe(true);
    expectConsecutiveVersions(ctx);
    expect(ctx.bots.events.filter((e) => e.kind === 'applied').map((e) => e.version)).not.toContain(version);
  });

  it('pacing: 800 + r*700 ms after a move, 1300 + r*500 ms after a bout resolution', async () => {
    const time = new FakeTime();
    const applied: number[] = [];
    let r = 0;
    const driver = new BotDriver({
      runner: new InProcessRunner(),
      moves: {
        async applyAutomatedMove() {
          applied.push(time.now());
          return ok({} as StoredGame);
        },
      },
      clock: time,
      scheduler: time,
      seedSource: () => 1,
      random: () => r,
      log: { error: () => undefined },
    });
    const { room, game } = handcraftedBotTurn();
    const t0 = time.now();

    r = 0;
    driver.onGameChanged(room, game, game.state); // same bout: an ordinary move
    await time.advanceBy(799);
    expect(applied).toEqual([]);
    await time.advanceBy(1);
    expect(applied).toEqual([t0 + DEFAULT_BOT_PACING.moveMinMs]);

    r = 0.999;
    const t1 = time.now();
    const v1 = { ...game, version: 1 };
    driver.onGameChanged(room, v1, { ...game.state, boutNumber: game.state.boutNumber - 1 });
    await time.advanceBy(1300 + 499 - 1);
    expect(applied).toHaveLength(1);
    await time.advanceBy(2);
    expect(applied[1]).toBeGreaterThanOrEqual(t1 + 1300 + 499);
    expect(applied[1]).toBeLessThan(t1 + 1800);
  });

  it('a newer version cancels the older plan before it applies', async () => {
    const time = new FakeTime();
    const calls: number[] = [];
    const driver = new BotDriver({
      runner: new InProcessRunner(),
      moves: {
        async applyAutomatedMove(_r, _p, _m, expectedVersion) {
          calls.push(expectedVersion);
          return ok({} as StoredGame);
        },
      },
      clock: time,
      scheduler: time,
      seedSource: () => 1,
      random: () => 0,
      log: { error: () => undefined },
    });
    const { room, game } = handcraftedBotTurn();
    driver.onGameChanged(room, game, null);
    await time.advanceBy(500);
    driver.onGameChanged(room, { ...game, version: 1 }, game.state);
    driver.onGameChanged(room, { ...game, version: 1 }, game.state); // duplicate notification: no-op
    await time.advanceBy(5_000);
    expect(calls).toEqual([1]);
  });
});

describe('AFK takeover', () => {
  it('the bot plays for an AFK human without resetting the abandon guard; a human move takes control back', async () => {
    const ctx = setupServices({ bots: { afkTakeover: true } });
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'a', maxPlayers: 2 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'b', noBind));
    await unwrap(ctx.rooms.startGame(host));
    const roomId = host.roomId;
    const sessions = [host, guest];

    // Let the timer run until someone is AFK.
    let afkId: string | undefined;
    for (let i = 0; i < 10 && !afkId; i++) {
      await ctx.time.advanceBy(TURN);
      afkId = (await load(ctx, roomId)).room.members.find((m) => m.afk)?.playerId;
    }
    expect(afkId).toBeDefined();
    const streakAtAfk = (await load(ctx, roomId)).game.timeoutStreak;
    expect(streakAtAfk).toBeGreaterThan(0);

    // The bot now plays that seat well before any deadline.
    let botPlayed = false;
    for (let i = 0; i < 40 && !botPlayed; i++) {
      await ctx.time.advanceBy(STEP);
      botPlayed = ctx.bots.events.some((e) => e.kind === 'applied' && e.playerId === afkId);
    }
    expect(botPlayed).toBe(true);
    const mid = await load(ctx, roomId);
    expect(mid.game.botAssisted).toContain(afkId);
    expect(mid.game.timeoutStreak).toBeGreaterThanOrEqual(streakAtAfk); // bot moves never reset it

    // The human acts as soon as they have a legal move: AFK cleared, bot control ends.
    const session = sessions.find((s) => s.id === afkId)!;
    let tookBack = false;
    for (let i = 0; i < 40 && !tookBack; i++) {
      const { game } = await load(ctx, roomId);
      if (game.state.phase.kind === 'finished') break;
      const moves = getLegalMoves(game.state, afkId!);
      if (moves.length > 0) {
        await unwrap(ctx.games.makeMove(session, roomId, toClient(moves[0]!), game.version));
        tookBack = true;
        break;
      }
      await ctx.time.advanceBy(100);
    }
    expect(tookBack).toBe(true);
    const after = await load(ctx, roomId);
    expect(after.room.members.find((m) => m.playerId === afkId)).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
    expect(after.game.timeoutStreak).toBe(0);
    expect(ctx.bots.inFlight.filter((e) => e.playerId === afkId)).toEqual([]);
    const appliedBefore = ctx.bots.events.filter((e) => e.kind === 'applied' && e.playerId === afkId).length;
    await ctx.time.advanceBy(STEP * 3);
    expect(ctx.bots.events.filter((e) => e.kind === 'applied' && e.playerId === afkId).length).toBe(appliedBefore);
  });

  it('session:resume also takes control back', async () => {
    const ctx = setupServices({ bots: { afkTakeover: true } });
    const host = await unwrap(ctx.rooms.createRoom({ nickname: 'a', maxPlayers: 2 }, noBind));
    const guest = await unwrap(ctx.rooms.joinRoom(host.roomId, 'b', noBind));
    await unwrap(ctx.rooms.startGame(host));
    for (let i = 0; i < 10; i++) {
      const { room } = await load(ctx, host.roomId);
      if (room.members.every((m) => m.afk)) break;
      await ctx.time.advanceBy(TURN);
    }
    const { game, room } = await load(ctx, host.roomId);
    expect(game.state.phase.kind).not.toBe('finished');
    expect(room.members.every((m) => m.afk)).toBe(true);
    expect(ctx.bots.inFlight.length).toBe(1); // the bot is planning for whoever is to act
    for (const s of [host, guest]) await unwrap(ctx.rooms.resume(s.token, noBind));
    expect(ctx.bots.inFlight).toEqual([]);
    const versionAfterResume = (await load(ctx, host.roomId)).game.version;
    await ctx.time.advanceBy(STEP * 2);
    expect((await load(ctx, host.roomId)).game.version).toBe(versionAfterResume); // nobody plays for them now
  });
});

describe('bots-only fast-forward', () => {
  it('once every human is out, the bots finish the game in the same commit', async () => {
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 1; seed++) {
      const ctx = setupServices({ seed });
      const { roomId, humans } = await botGame(ctx, { bots: ['easy', 'easy'] });
      await playOut(ctx, roomId, humans);
      const human = humans[0]!.id;
      for (const e of ctx.notifier.of('game')) {
        const s = e.game!.state;
        // Never a broadcast state where only bots are still in and the game goes on.
        if (s.phase.kind !== 'finished') expect(s.finishOrder).not.toContain(human);
      }
      const final = (await load(ctx, roomId)).game.state;
      const humanOutBeforeEnd = final.finishOrder.indexOf(human) >= 0 && final.finishOrder.indexOf(human) < final.players.length - 2;
      if (humanOutBeforeEnd) checked++;
      expectConsecutiveVersions(ctx);
    }
    expect(checked).toBe(1);
  });

  it('fastForwardIfBotsOnly plays a bots-only state to a durak, and ignores states with a human still in', () => {
    const created = createGame({ playerIds: ['h', 'b1', 'b2'], seed: 5, config: {} });
    if (!created.ok) throw new Error('setup');
    const room = roomWith(['h', 'b1', 'b2'], ['b1', 'b2']);
    expect(fastForwardIfBotsOnly(room, created.value)).toBeNull();

    const allBots = roomWith(['h', 'b1', 'b2'], ['h', 'b1', 'b2']);
    const result = fastForwardIfBotsOnly(allBots, created.value);
    expect(result?.state.phase.kind).toBe('finished');
    expect(result?.endReason).toBe('normal');
  });
});

describe('no cheating: bot jobs carry only public information', () => {
  it('no serialized job contains a card the seat cannot see or prove (3 seats, full game)', async () => {
    const recorded: { json: string; state: GameState }[] = [];
    const holder: { ctx?: Ctx } = {};
    const inner = new InProcessRunner();
    const spy: BotRunner = {
      run(job: BotJob, signal: AbortSignal) {
        const last = holder.ctx!.notifier.of('game').at(-1)!.game!;
        recorded.push({ json: JSON.stringify(job), state: last.state });
        return inner.run(job, signal);
      },
      dispose: () => inner.dispose(),
    };
    const options: ServiceHarnessOptions = { seed: 3, bots: { runner: spy } };
    const ctx = setupServices(options);
    holder.ctx = ctx;
    const { roomId, humans } = await botGame(ctx, { bots: ['medium', 'hard'] });
    await playOut(ctx, roomId, humans);
    expect(recorded.length).toBeGreaterThan(10);

    for (const { json, state } of recorded) {
      const job = JSON.parse(json) as BotJob;
      expect(Object.keys(job).sort()).toEqual(['jobId', 'knowledge', 'options', 'view']);
      const me = job.view.viewerId!;
      const hidden = new Set<string>();
      for (const p of state.players) {
        if (p.id === me) continue;
        const known = new Set(job.knowledge.knownHands[p.id] ?? []);
        for (const c of p.hand) if (!known.has(cardId(c))) hidden.add(cardId(c));
      }
      for (const c of state.deck) if (cardId(c) !== cardId(state.trumpCard)) hidden.add(cardId(c));
      const provenDiscard = new Set(job.knowledge.discard);
      for (const c of state.discard) if (!provenDiscard.has(cardId(c))) hidden.add(cardId(c));

      const mentioned = collectCards(JSON.parse(json));
      for (const id of mentioned) expect(hidden.has(id), `job for ${me} leaks ${id}`).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ helpers

function toClient(move: { playerId: string } & ClientMove): ClientMove {
  const { playerId: _p, ...rest } = move;
  return rest as ClientMove;
}

function roomWith(ids: string[], botIds: string[]): Room {
  return {
    id: 'room1',
    hostId: ids[0]!,
    maxPlayers: ids.length,
    config: {},
    members: ids.map((id) =>
      botIds.includes(id)
        ? newBotMember(id, id, 'easy')
        : { playerId: id, nickname: id, connected: true, isBot: false, botDifficulty: null, afk: false, consecutiveTimeouts: 0, graceDeadline: null, leftGame: false },
    ),
    spectators: [],
    status: 'playing',
    createdAt: 0,
    restartVote: null,
    restartCooldowns: {},
  };
}

/** A 2-seat game where the canonical actor is a bot seat with at least two legal moves. */
function handcraftedBotTurn(): { room: Room; game: StoredGame } {
  for (let seed = 1; ; seed++) {
    const created = createGame({ playerIds: ['h', 'b'], seed, config: {} });
    if (!created.ok) continue;
    let state = created.value;
    if (state.players[state.attackerIndex]!.id !== 'b') {
      // Human opens; the bot then defends (canonical actor = defender).
      const attacker = state.players[state.attackerIndex]!;
      const opened = applyMove(state, { type: 'attack', playerId: attacker.id, card: attacker.hand[0]! });
      if (!opened.ok) continue;
      state = opened.value;
    }
    if (state.players[canonicalActor(state)]?.id !== 'b' || getLegalMoves(state, 'b').length < 2) continue;
    const game: StoredGame = {
      roomId: 'room1',
      gameId: 'g1',
      seed,
      version: 0,
      state,
      startedAt: 0,
      turnDeadline: null,
      timeoutStreak: 0,
      endReason: null,
      knowledge: {},
      botAssisted: [],
      forfeits: [],
      stats: {},
    };
    return { room: roomWith(['h', 'b'], ['b']), game };
  }
}

/** Every card mentioned in a job: card objects anywhere, and card-id strings in the knowledge. */
function collectCards(job: { knowledge: { discard: string[]; knownHands: Record<string, string[]> } } & object): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.rank === 'number' && typeof o.suit === 'string') out.add(cardId(o as unknown as Card));
      Object.values(o).forEach(walk);
    }
  };
  walk(job);
  for (const id of job.knowledge.discard) out.add(id);
  for (const ids of Object.values(job.knowledge.knownHands)) for (const id of ids) out.add(id);
  return out;
}
