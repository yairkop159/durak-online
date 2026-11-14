import type { GameState } from '@durak/game-engine';
import { REACTION_BURST, REACTION_REFILL_MS, type ReactionId } from '@durak/shared';
import type { Room, Session, StoredGame } from '../domain/types.js';
import { fail, ok, type Result } from '../domain/result.js';
import type { Repositories } from '../repositories/interfaces.js';
import { TokenBucket } from './tokenBucket.js';
import { gameEvents, type GameEvent } from './gameEvents.js';
import type { GameChangeInfo, GameChangeListener, RoomNotifier } from './ports.js';
import type { Clock, Scheduler, TimerHandle } from './scheduling.js';

export interface ReactionSettings {
  /** Per player: burst, then one reaction per `refillMs`. */
  readonly burst: number;
  readonly refillMs: number;
  /** Chance that a bot reacts to one of its own big moments. */
  readonly botChance: number;
  /** Per bot: at most `botBurst` reactions, refilled one per `botRefillMs`. */
  readonly botBurst: number;
  readonly botRefillMs: number;
  /** A bot reacts this long after the move (lands after the client's animation). */
  readonly botDelayMinMs: number;
  readonly botDelayMaxMs: number;
}

export const DEFAULT_REACTION_SETTINGS: ReactionSettings = {
  burst: REACTION_BURST,
  refillMs: REACTION_REFILL_MS,
  botChance: 0.35,
  botBurst: 1,
  botRefillMs: 15_000,
  botDelayMinMs: 700,
  botDelayMaxMs: 1_500,
};

/** A beaten bout this big counts as a "perfect defense" (every beaten bout is fully covered). */
export const PERFECT_DEFENSE_MIN_PAIRS = 3;

/** Buckets idle this long are dropped (they would be full again by then anyway). */
const BUCKET_IDLE_MS = 60_000;
const SWEEP_ABOVE = 1_000;

export interface ReactionServiceDeps {
  readonly repos: Repositories;
  readonly notifier: RoomNotifier;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** In [0, 1); server-side randomness for bot reactions (default Math.random). */
  readonly random?: () => number;
  readonly settings?: Partial<ReactionSettings>;
}

/** A bot's own moment → the reactions it may pick from. */
type BotMoment = 'perfectDefense' | 'transfer' | 'wentOut' | 'durak';
const BOT_REACTIONS: Record<BotMoment, readonly ReactionId[]> = {
  perfectDefense: ['fire', 'nice'],
  transfer: ['laugh', 'think'],
  wentOut: ['clap', 'fire'],
  durak: ['ohNo', 'shock'],
};

/** Which bot moments a step contains, per bot seat (at most one per seat: the biggest). */
export function botMoments(events: readonly GameEvent[], isBot: (id: string) => boolean): Map<string, BotMoment> {
  const out = new Map<string, BotMoment>();
  const rank: Record<BotMoment, number> = { durak: 4, wentOut: 3, perfectDefense: 2, transfer: 1 };
  const offer = (id: string, moment: BotMoment) => {
    if (!isBot(id)) return;
    const current = out.get(id);
    if (!current || rank[moment] > rank[current]) out.set(id, moment);
  };
  for (const e of events) {
    if (e.type === 'played' && e.role === 'transfer') offer(e.by, 'transfer');
    else if (e.type === 'resolved' && e.outcome === 'beaten' && e.pairs >= PERFECT_DEFENSE_MIN_PAIRS) offer(e.defenderId, 'perfectDefense');
    else if (e.type === 'wentOut') offer(e.playerId, 'wentOut');
    else if (e.type === 'finished' && e.durak !== null) offer(e.durak, 'durak');
  }
  return out;
}

/**
 * Quick reactions. Ephemeral: validated, rate limited and broadcast, never stored.
 * Also a GameChangeListener: bots occasionally react to their own big moments.
 */
export class ReactionService implements GameChangeListener {
  private readonly settings: ReactionSettings;
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>();
  private readonly pending = new Set<TimerHandle>();

  constructor(private readonly deps: ReactionServiceDeps) {
    this.settings = { ...DEFAULT_REACTION_SETTINGS, ...deps.settings };
  }

  /**
   * A seated player (not a spectator, not one who left the game) reacts. Over the limit, the
   * reaction is dropped silently (`ok(false)`): the client mirrors the bucket and greys out.
   */
  async react(session: Session, roomId: string, reactionId: ReactionId): Promise<Result<boolean>> {
    if (session.role !== 'player' || session.roomId !== roomId) return fail('NOT_IN_ROOM', 'Only seated players can react');
    const room = await this.deps.repos.rooms.get(roomId);
    if (!room) return fail('ROOM_NOT_FOUND', 'Room no longer exists');
    const member = room.members.find((m) => m.playerId === session.id);
    if (!member || member.leftGame || member.isBot) return fail('NOT_IN_ROOM', 'Only seated players can react');
    const { burst, refillMs } = this.settings;
    if (!this.take(`p:${roomId}:${session.id}`, burst, refillMs)) return ok(false);
    this.deps.notifier.reaction(room, { playerId: session.id, reactionId });
    return ok(true);
  }

  onGameChanged(room: Room, game: StoredGame, prev: GameState | null, info?: GameChangeInfo): void {
    // Only real moves (not start/resume/startup), and never the bots-only fast-forward.
    if (prev === null || info?.fastForwarded) return;
    const isBot = (id: string) => room.members.find((m) => m.playerId === id)?.isBot === true;
    const moments = botMoments(gameEvents(prev, game.state), isBot);
    const { botChance, botBurst, botRefillMs, botDelayMinMs, botDelayMaxMs } = this.settings;
    for (const [botId, moment] of moments) {
      if (this.random() >= botChance) continue;
      if (!this.take(`b:${room.id}:${botId}`, botBurst, botRefillMs)) continue;
      const options = BOT_REACTIONS[moment];
      const reactionId = options[Math.min(options.length - 1, Math.floor(this.random() * options.length))]!;
      const delay = botDelayMinMs + this.random() * (botDelayMaxMs - botDelayMinMs);
      const handle = this.deps.scheduler.schedule(this.deps.clock.now() + delay, async () => {
        this.pending.delete(handle);
        const current = await this.deps.repos.rooms.get(room.id);
        if (!current || !current.members.some((m) => m.playerId === botId && m.isBot)) return;
        this.deps.notifier.reaction(current, { playerId: botId, reactionId });
      });
      this.pending.add(handle);
    }
  }

  dispose(): void {
    for (const handle of this.pending) this.deps.scheduler.cancel(handle);
    this.pending.clear();
    this.buckets.clear();
  }

  private random(): number {
    return Math.min(Math.max((this.deps.random ?? Math.random)(), 0), 0.999_999);
  }

  private take(key: string, burst: number, refillMs: number): boolean {
    const now = this.deps.clock.now();
    if (this.buckets.size > SWEEP_ABOVE) {
      for (const [k, v] of this.buckets) if (now - v.lastUsed > BUCKET_IDLE_MS) this.buckets.delete(k);
    }
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(burst, 1000 / refillMs, () => this.deps.clock.now()), lastUsed: now };
      this.buckets.set(key, entry);
    }
    entry.lastUsed = now;
    return entry.bucket.tryTake();
  }
}
