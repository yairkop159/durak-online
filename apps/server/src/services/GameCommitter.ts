import {
  abandon,
  applyMove,
  canonicalActor,
  createRng,
  GreedyBot,
  initKnowledge,
  sanitizeStateForPlayer,
  updateKnowledge,
  type GameState,
  type PublicKnowledge,
} from '@durak/game-engine';
import type { GameEndReason, PlayerId } from '@durak/shared';
import type { Room, StoredGame } from '../domain/types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { GameChangeListener, RoomNotifier } from './ports.js';
import type { TurnTimerService } from './TurnTimerService.js';

export interface GameCommitterDeps {
  readonly repos: Repositories;
  readonly notifier: RoomNotifier;
  readonly timers: TurnTimerService;
  /** Late-bound (the BotDriver is built after the services it uses). */
  readonly listener: () => GameChangeListener | null;
}

export interface CommitInput {
  /** The room after this change (status is set to 'finished' here if the game ends). */
  readonly room: Room;
  /** Whether `room` differs from the stored room (members changed): saved and broadcast. */
  readonly roomChanged: boolean;
  readonly prev: StoredGame;
  readonly state: GameState;
  /** Default: unchanged. */
  readonly timeoutStreak?: number;
  /** Default: 'normal' if the game finished, else null. */
  readonly endReason?: GameEndReason | null;
  /** Default: unchanged. */
  readonly botAssisted?: readonly PlayerId[];
  /** Default: unchanged. */
  readonly forfeits?: readonly PlayerId[];
}

/** Moves the bots-only fast-forward may play before it gives up and abandons the game. */
export const FAST_FORWARD_MAX_MOVES = 3000;

/**
 * The single write path for game changes (must be called inside the room lock):
 * version + 1, knowledge update for every seat, bots-only fast-forward, deadline, atomic save,
 * broadcast, timer re-arm, and finally the change listener (bot planning).
 * Nothing else writes a new game version, so "after every state change" holds by construction.
 */
export class GameCommitter {
  constructor(private readonly deps: GameCommitterDeps) {}

  /** Version 0: initial knowledge for every seat, save, broadcast, arm. */
  async start(room: Room, game: StoredGame): Promise<StoredGame> {
    const { repos, notifier, timers } = this.deps;
    const knowledge: Record<PlayerId, PublicKnowledge> = {};
    for (const p of game.state.players) knowledge[p.id] = initKnowledge(sanitizeStateForPlayer(game.state, p.id));
    const started: StoredGame = { ...game, knowledge, turnDeadline: timers.deadlineFor(room, game.state) };
    await repos.atomic.saveRoomAndGame(room, started);
    timers.armTurn(started);
    notifier.roomState(room);
    notifier.gameState(room, started);
    this.announce(room, started, null);
    return started;
  }

  async commit(input: CommitInput): Promise<{ room: Room; game: StoredGame }> {
    const { repos, notifier, timers } = this.deps;
    const { prev } = input;
    let state = input.state;
    let endReason = input.endReason;

    const forwarded = fastForwardIfBotsOnly(input.room, state);
    if (forwarded) {
      state = forwarded.state;
      endReason = forwarded.endReason;
    }

    const finished = state.phase.kind === 'finished';
    const room: Room = finished ? { ...input.room, status: 'finished' } : input.room;
    const roomChanged = input.roomChanged || room.status !== input.room.status || finished;
    const game: StoredGame = {
      ...prev,
      version: prev.version + 1,
      state,
      timeoutStreak: input.timeoutStreak ?? prev.timeoutStreak,
      endReason: endReason !== undefined ? endReason : finished ? 'normal' : null,
      turnDeadline: timers.deadlineFor(room, state),
      knowledge: advanceKnowledge(prev.state, state, prev.knowledge),
      botAssisted: input.botAssisted ?? prev.botAssisted,
      forfeits: input.forfeits ?? prev.forfeits,
    };

    if (roomChanged) await repos.atomic.saveRoomAndGame(room, game);
    else await repos.games.save(game);

    if (roomChanged) notifier.roomState(room);
    notifier.gameState(room, game);
    if (finished) {
      notifier.gameOver(room, game);
      timers.cancelRoom(room.id);
    } else {
      timers.armTurn(game);
    }
    this.announce(room, game, prev.state);
    return { room, game };
  }

  /** Tells the listener about a change that did not go through `commit` (resume, startup). */
  announce(room: Room, game: StoredGame, prev: GameState | null): void {
    this.deps.listener()?.onGameChanged(room, game, prev);
  }
}

/**
 * Advances every seat's knowledge from the views of `prev` to the views of `next` — exactly the
 * two consecutive game:state views that player receives. Views are built here only to feed
 * `updateKnowledge`; they never leave the server.
 */
export function advanceKnowledge(
  prev: GameState,
  next: GameState,
  knowledge: Readonly<Record<PlayerId, PublicKnowledge>>,
): Record<PlayerId, PublicKnowledge> {
  const out: Record<PlayerId, PublicKnowledge> = {};
  for (const p of next.players) {
    const prevView = sanitizeStateForPlayer(prev, p.id);
    const nextView = sanitizeStateForPlayer(next, p.id);
    out[p.id] = updateKnowledge(knowledge[p.id] ?? initKnowledge(prevView), prevView, nextView);
  }
  return out;
}

/**
 * A game never continues with only bots: once every player still in is a bot, the rest is played
 * out immediately (GreedyBot, each seat deciding from its own view only). Null if not applicable.
 */
export function fastForwardIfBotsOnly(
  room: Room,
  state: GameState,
): { state: GameState; endReason: GameEndReason } | null {
  if (state.phase.kind === 'finished') return null;
  const isBot = (id: string) => room.members.find((m) => m.playerId === id)?.isBot === true;
  const stillIn = state.players.filter((p) => !state.finishOrder.includes(p.id));
  if (stillIn.length === 0 || !stillIn.every((p) => isBot(p.id))) return null;

  let current = state;
  for (let i = 0; i < FAST_FORWARD_MAX_MOVES; i++) {
    if (current.phase.kind === 'finished') return { state: current, endReason: 'normal' };
    const actor = canonicalActor(current);
    if (actor < 0) break;
    const id = current.players[actor]!.id;
    const view = sanitizeStateForPlayer(current, id);
    const move = GreedyBot.choose(view, initKnowledge(view), createRng(i));
    if (!move) break;
    const next = applyMove(current, { ...move, playerId: id });
    if (!next.ok) break;
    current = next.value;
  }
  if (current.phase.kind === 'finished') return { state: current, endReason: 'normal' };
  const abandoned = abandon(current);
  return abandoned.ok ? { state: abandoned.value, endReason: 'abandoned' } : null;
}
