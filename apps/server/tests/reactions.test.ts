import { createGame, type GameState } from '@durak/game-engine';
import type { BotDifficulty } from '@durak/shared';
import { describe, expect, it } from 'vitest';
import type { Session, StoredGame } from '../src/domain/types.js';
import type { GameEvent } from '../src/services/gameEvents.js';
import { botMoments, PERFECT_DEFENSE_MIN_PAIRS } from '../src/services/ReactionService.js';
import { noBind, setupServices, unwrap } from './helpers/serviceHarness.js';

type Ctx = ReturnType<typeof setupServices>;

async function room(ctx: Ctx, opts: { humans: number; bots?: BotDifficulty[]; maxPlayers?: number }) {
  const total = opts.maxPlayers ?? opts.humans + (opts.bots?.length ?? 0);
  const host = await unwrap(ctx.rooms.createRoom({ nickname: 'h0', maxPlayers: total }, noBind));
  const humans: Session[] = [host];
  for (let i = 1; i < opts.humans; i++) humans.push(await unwrap(ctx.rooms.joinRoom(host.roomId, `h${i}`, noBind)));
  const botIds: string[] = [];
  for (const d of opts.bots ?? []) botIds.push((await unwrap(ctx.rooms.addBot(host, d))).playerId);
  return { roomId: host.roomId, humans, botIds };
}

const reactions = (ctx: Ctx) => ctx.notifier.of('reaction').map((e) => ({ roomId: e.room.id, ...e.reaction! }));

describe('quick reactions (service)', () => {
  it('a seated player reacts: broadcast to the room, nothing stored', async () => {
    const ctx = setupServices();
    const { roomId, humans } = await room(ctx, { humans: 2 });
    const roomBefore = JSON.stringify(await ctx.repos.rooms.get(roomId));
    expect(await ctx.reactions.react(humans[1]!, roomId, 'laugh')).toEqual({ ok: true, value: true });
    expect(reactions(ctx)).toEqual([{ roomId, playerId: humans[1]!.id, reactionId: 'laugh' }]);
    expect(JSON.stringify(await ctx.repos.rooms.get(roomId))).toBe(roomBefore);
    expect(await ctx.repos.games.get(roomId)).toBeNull();
  });

  it('spectators, other rooms and seats that left the game may not react', async () => {
    const ctx = setupServices();
    const { roomId, humans } = await room(ctx, { humans: 2 });
    const watcher = await unwrap(ctx.rooms.joinRoom(roomId, 'w', noBind));
    expect(watcher.role).toBe('spectator');
    expect((await ctx.reactions.react(watcher, roomId, 'fire')).ok).toBe(false);
    const other = await room(ctx, { humans: 1, maxPlayers: 2 });
    const res = await ctx.reactions.react(humans[0]!, other.roomId, 'fire');
    expect(res.ok ? null : res.error.code).toBe('NOT_IN_ROOM');

    // A player who left a running 3-player game (bot takeover) can't react for that seat.
    const three = await room(ctx, { humans: 3 });
    await unwrap(ctx.rooms.startGame(three.humans[0]!));
    const leaver = three.humans[2]!;
    await unwrap(ctx.rooms.leaveRoom(leaver));
    expect((await ctx.reactions.react(leaver, three.roomId, 'ohNo')).ok).toBe(false);
    expect(reactions(ctx)).toEqual([]);
  });

  it('per player: a burst of 3, then one every 2 s; over the limit is dropped silently', async () => {
    const ctx = setupServices();
    const { roomId, humans } = await room(ctx, { humans: 2 });
    const [a, b] = humans as [Session, Session];
    for (let i = 0; i < 3; i++) expect(await ctx.reactions.react(a, roomId, 'clap')).toEqual({ ok: true, value: true });
    expect(await ctx.reactions.react(a, roomId, 'clap')).toEqual({ ok: true, value: false });
    // Another player has their own bucket.
    expect(await ctx.reactions.react(b, roomId, 'think')).toEqual({ ok: true, value: true });
    await ctx.time.advanceBy(1_999);
    expect(await ctx.reactions.react(a, roomId, 'clap')).toEqual({ ok: true, value: false });
    await ctx.time.advanceBy(1);
    expect(await ctx.reactions.react(a, roomId, 'clap')).toEqual({ ok: true, value: true });
    await ctx.time.advanceBy(2_000);
    expect(await ctx.reactions.react(a, roomId, 'again')).toEqual({ ok: true, value: true });
    expect(reactions(ctx).filter((r) => r.playerId === a.id)).toHaveLength(5);
  });
});

describe('bot reactions', () => {
  const ev = (...events: GameEvent[]) => events;
  const isBot = (id: string) => id.startsWith('b');

  it('picks each bot seat’s biggest own moment, never a human’s', () => {
    const moments = botMoments(
      ev(
        { type: 'played', by: 'b1', card: { suit: 'S', rank: 7 }, role: 'transfer' },
        { type: 'played', by: 'h1', card: { suit: 'S', rank: 8 }, role: 'transfer' },
        { type: 'resolved', outcome: 'beaten', defenderId: 'b2', pairs: PERFECT_DEFENSE_MIN_PAIRS, cards: 6 },
        { type: 'wentOut', playerId: 'b2' },
        { type: 'finished', durak: 'b3' },
      ),
      isBot,
    );
    expect(Object.fromEntries(moments)).toEqual({ b1: 'transfer', b2: 'wentOut', b3: 'durak' });
    // A small beaten bout is not a "perfect defense".
    const small = botMoments(ev({ type: 'resolved', outcome: 'beaten', defenderId: 'b2', pairs: 2, cards: 4 }), isBot);
    expect(small.size).toBe(0);
  });

  function fakeStep(durak: string): { prev: GameState; game: StoredGame } {
    const created = createGame({ playerIds: ['h', durak], seed: 5, config: {} });
    if (!created.ok) throw new Error('setup');
    const prev = created.value;
    const next: GameState = { ...prev, phase: { kind: 'finished', durak } };
    return { prev, game: { state: next } as StoredGame };
  }

  it('a bot reacts after a delay when the dice say so; its own bucket caps repeats', async () => {
    const ctx = setupServices({ reactions: { settings: { botChance: 1 }, random: () => 0 } });
    const { roomId, botIds } = await room(ctx, { humans: 1, bots: ['easy'] });
    const theRoom = (await ctx.repos.rooms.get(roomId))!;
    const { prev, game } = fakeStep(botIds[0]!);
    ctx.reactions.onGameChanged(theRoom, game, prev);
    ctx.reactions.onGameChanged(theRoom, game, prev); // same moment again: bucket (burst 1) says no
    expect(reactions(ctx)).toEqual([]);
    await ctx.time.advanceBy(699);
    expect(reactions(ctx)).toEqual([]);
    await ctx.time.advanceBy(1);
    expect(reactions(ctx)).toEqual([{ roomId, playerId: botIds[0], reactionId: 'ohNo' }]);
    await ctx.time.advanceBy(5_000);
    expect(reactions(ctx)).toHaveLength(1);
  });

  it('no reaction when the dice say no, on start/resume (no prev), or during the bots-only fast-forward', async () => {
    const ctx = setupServices({ reactions: { settings: { botChance: 0.35 }, random: () => 0.5 } });
    const { roomId, botIds } = await room(ctx, { humans: 1, bots: ['easy'] });
    const theRoom = (await ctx.repos.rooms.get(roomId))!;
    const { prev, game } = fakeStep(botIds[0]!);
    ctx.reactions.onGameChanged(theRoom, game, prev); // 0.5 >= 0.35
    const sure = setupServices({ reactions: { settings: { botChance: 1 }, random: () => 0 } });
    const r2 = await room(sure, { humans: 1, bots: ['easy'] });
    const room2 = (await sure.repos.rooms.get(r2.roomId))!;
    const step2 = fakeStep(r2.botIds[0]!);
    sure.reactions.onGameChanged(room2, step2.game, null);
    sure.reactions.onGameChanged(room2, step2.game, step2.prev, { fastForwarded: true, tournamentClosed: false });
    await ctx.time.advanceBy(5_000);
    await sure.time.advanceBy(5_000);
    expect(reactions(ctx)).toEqual([]);
    expect(reactions(sure)).toEqual([]);
  });

  it('end to end: the bot reacts to how a real game ends (it goes out or is the durak)', async () => {
    const ctx = setupServices({ reactions: { settings: { botChance: 1 } } });
    const { roomId, humans, botIds } = await room(ctx, { humans: 1, bots: ['easy'] });
    await unwrap(ctx.rooms.startGame(humans[0]!));
    const { chooseMove } = await import('./helpers/viewStrategy.js');
    const { sanitizeStateForPlayer } = await import('@durak/game-engine');
    for (let i = 0; i < 3000; i++) {
      const game = (await ctx.repos.games.get(roomId))!;
      if (game.state.phase.kind === 'finished') break;
      const move = chooseMove(sanitizeStateForPlayer(game.state, humans[0]!.id));
      if (move) {
        const r = await ctx.games.makeMove(humans[0]!, roomId, move, game.version);
        if (r.ok) continue;
      }
      await ctx.time.advanceBy(2_000);
    }
    expect((await ctx.repos.games.get(roomId))!.state.phase.kind).toBe('finished');
    await ctx.time.advanceBy(2_000);
    const fromBot = reactions(ctx).filter((r) => r.playerId === botIds[0]);
    expect(fromBot.length).toBeGreaterThan(0);
    expect(['clap', 'fire', 'ohNo', 'shock', 'laugh', 'think', 'nice']).toContain(fromBot.at(-1)!.reactionId);
  });
});
