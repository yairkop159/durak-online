import { sanitizeStateForPlayer } from '@durak/game-engine';
import type { GameRatingsPayload, GameStatePayload, ReactionPayload, RestartVoteEndedPayload, RoomStatePayload } from '@durak/shared';
import type { Room, Session, StoredGame } from '../domain/types.js';
import type { RoomNotifier } from '../services/ports.js';
import type { Clock } from '../services/scheduling.js';
import { channels, type IoServer } from './socketTypes.js';

/** Fields are mapped explicitly: server-only member state (timeout counters, grace) never leaves. */
export function toRoomStatePayload(room: Room, now: number): RoomStatePayload {
  const vote = room.restartVote;
  return {
    roomId: room.id,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    members: room.members.map((m) => ({
      playerId: m.playerId,
      nickname: m.nickname,
      connected: m.connected,
      isBot: m.isBot,
      botDifficulty: m.botDifficulty,
      afk: m.afk,
      leftGame: m.leftGame,
    })),
    spectatorCount: room.spectators.length,
    status: room.status,
    restartVote: vote
      ? {
          voteId: vote.voteId,
          proposerId: vote.proposerId,
          expiresAt: vote.expiresAt,
          serverTime: now,
          accepted: [...vote.accepted],
          awaiting: vote.voters.filter((id) => !vote.accepted.includes(id)),
        }
      : null,
  };
}

/**
 * Delivers state over Socket.io. Every game:state payload is built per recipient through
 * sanitizeStateForPlayer — there is never one shared payload containing hidden cards.
 */
export class SocketNotifier implements RoomNotifier {
  constructor(
    private readonly io: IoServer,
    private readonly clock: Clock,
  ) {}

  roomState(room: Room): void {
    this.io.to(channels.room(room.id)).emit('room:state', toRoomStatePayload(room, this.clock.now()));
  }

  gameState(room: Room, game: StoredGame): void {
    for (const member of room.members) {
      this.io.to(channels.player(member.playerId)).emit('game:state', this.viewFor(game, member.playerId));
    }
    this.io.to(channels.spectators(room.id)).emit('game:state', this.viewFor(game, null));
  }

  gameOver(room: Room, game: StoredGame): void {
    const phase = game.state.phase;
    this.io.to(channels.room(room.id)).emit('game:over', {
      roomId: room.id,
      durakId: phase.kind === 'finished' ? phase.durak : null,
      finishOrder: [...game.state.finishOrder],
      endReason: game.endReason ?? 'normal',
      botAssisted: [...game.botAssisted],
      forfeits: [...game.forfeits],
      stats: game.stats,
    });
  }

  restartVoteEnded(room: Room, ended: Omit<RestartVoteEndedPayload, 'roomId'>): void {
    this.io.to(channels.room(room.id)).emit('room:restartVoteEnded', { roomId: room.id, ...ended });
  }

  reaction(room: Room, reaction: Omit<ReactionPayload, 'roomId'>): void {
    this.io.to(channels.room(room.id)).emit('room:reaction', { roomId: room.id, ...reaction });
  }

  sendGameStateTo(_room: Room, game: StoredGame, viewer: Session): void {
    if (viewer.role === 'player') {
      this.io.to(channels.player(viewer.id)).emit('game:state', this.viewFor(game, viewer.id));
    } else {
      this.io.to(channels.spectator(viewer.id)).emit('game:state', this.viewFor(game, null));
    }
  }

  gameRatings(room: Room, payload: GameRatingsPayload): void {
    this.io.to(channels.room(room.id)).emit('game:ratings', payload);
  }

  gameRatingsTo(viewer: Session, payload: GameRatingsPayload): void {
    const channel = viewer.role === 'player' ? channels.player(viewer.id) : channels.spectator(viewer.id);
    this.io.to(channel).emit('game:ratings', payload);
  }

  private viewFor(game: StoredGame, playerId: string | null): GameStatePayload {
    return {
      roomId: game.roomId,
      gameId: game.gameId,
      version: game.version,
      view: sanitizeStateForPlayer(game.state, playerId),
      turnDeadline: game.turnDeadline,
      serverTime: this.clock.now(),
    };
  }
}
