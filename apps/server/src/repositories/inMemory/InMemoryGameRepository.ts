import type { StoredGame } from '../../domain/types.js';
import type { GameRepository } from '../interfaces.js';
import { InMemoryStore } from './InMemoryStore.js';

export class InMemoryGameRepository implements GameRepository {
  private readonly store = new InMemoryStore<StoredGame>();

  async get(roomId: string): Promise<StoredGame | null> {
    return this.store.get(roomId);
  }

  async save(game: StoredGame): Promise<void> {
    this.store.set(game.roomId, game);
  }

  async delete(roomId: string): Promise<void> {
    this.store.delete(roomId);
  }
}
