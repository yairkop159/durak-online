import type { Room, Session, StoredGame } from '../../domain/types.js';
import type { Repositories, RoomGameTransaction } from '../interfaces.js';
import { gameTtlSeconds, roomTtlSeconds } from '../ttl.js';
import { InMemoryGameRepository } from './InMemoryGameRepository.js';
import { InMemoryRoomRepository } from './InMemoryRoomRepository.js';
import { InMemorySessionRepository } from './InMemorySessionRepository.js';
import { InMemoryStore, type Clock } from './InMemoryStore.js';

export { InMemoryGameRepository, InMemoryRoomRepository, InMemorySessionRepository, InMemoryStore };

export interface InMemoryRepositories extends Repositories {
  readonly rooms: InMemoryRoomRepository;
  readonly games: InMemoryGameRepository;
  readonly sessions: InMemorySessionRepository;
}

export function createInMemoryRepositories(now: Clock = Date.now): InMemoryRepositories {
  const roomStore = new InMemoryStore<Room>(now);
  const gameStore = new InMemoryStore<StoredGame>(now);
  const sessionStore = new InMemoryStore<Session>(now);

  // Both writes happen synchronously in one tick, so they are atomic by construction.
  const atomic: RoomGameTransaction = {
    async saveRoomAndGame(room, game) {
      roomStore.set(room.id, room, roomTtlSeconds(room));
      gameStore.set(game.roomId, game, gameTtlSeconds(game));
    },
    async saveRoomDeleteGame(room) {
      roomStore.set(room.id, room, roomTtlSeconds(room));
      gameStore.delete(room.id);
    },
    async deleteRoomAndGame(roomId) {
      roomStore.delete(roomId);
      gameStore.delete(roomId);
    },
  };

  return {
    rooms: new InMemoryRoomRepository(roomStore),
    games: new InMemoryGameRepository(gameStore, roomStore),
    sessions: new InMemorySessionRepository(sessionStore),
    atomic,
  };
}
