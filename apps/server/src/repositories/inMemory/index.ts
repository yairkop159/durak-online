import type { Repositories } from '../interfaces.js';
import { InMemoryGameRepository } from './InMemoryGameRepository.js';
import { InMemoryRoomRepository } from './InMemoryRoomRepository.js';
import { InMemorySessionRepository } from './InMemorySessionRepository.js';

export { InMemoryGameRepository, InMemoryRoomRepository, InMemorySessionRepository };

export function createInMemoryRepositories(): Repositories {
  return {
    rooms: new InMemoryRoomRepository(),
    games: new InMemoryGameRepository(),
    sessions: new InMemorySessionRepository(),
  };
}
