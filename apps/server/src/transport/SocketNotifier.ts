import { sanitizeStateForPlayer } from '@durak/game-engine';
import type { GameStatePayload, RoomStatePayload } from '@durak/shared';
import type { Room, Session, StoredGame } from '../domain/types.js';
import type { RoomNotifier } from '../services/ports.js';
import { channels, type IoServer } from './socketTypes.js';

export function toRoomStatePayload(room: Room): RoomStatePayload {
  return {
    roomId: room.id,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    members: room.members.map((m) => ({ ...m })),
    spectatorCount: room.spectators.length,
    status: room.status,
  };
}

/**
 * Delivers state over Socket.io. Every game:state payload is built per recipient through
 * sanitizeStateForPlayer — there is never one shared payload containing hidden cards.
 */
export class SocketNotifier implements RoomNotifier {
  constructor(private readonly io: IoServer) {}

  roomState(room: Room): void {
    this.io.to(channels.room(room.id)).emit('room:state', toRoomStatePayload(room));
  }

  gameState(room: Room, game: StoredGame): void {
    for (const member of room.members) {
      this.io.to(channels.player(member.playerId)).emit('game:state', viewFor(game, member.playerId));
    }
    this.io.to(channels.spectators(room.id)).emit('game:state', viewFor(game, null));
  }

  gameOver(room: Room, game: StoredGame): void {
    const phase = game.state.phase;
    this.io.to(channels.room(room.id)).emit('game:over', {
      roomId: room.id,
      durakId: phase.kind === 'finished' ? phase.durak : null,
      finishOrder: [...game.state.finishOrder],
    });
  }

  sendGameStateTo(_room: Room, game: StoredGame, viewer: Session): void {
    if (viewer.role === 'player') {
      this.io.to(channels.player(viewer.id)).emit('game:state', viewFor(game, viewer.id));
    } else {
      this.io.to(channels.spectator(viewer.id)).emit('game:state', viewFor(game, null));
    }
  }
}

function viewFor(game: StoredGame, playerId: string | null): GameStatePayload {
  return { roomId: game.roomId, version: game.version, view: sanitizeStateForPlayer(game.state, playerId) };
}
