import type { Room, StoredGame } from '../../domain/types.js';
import type { GameRepository } from '../interfaces.js';
import { gameTtlSeconds, roomTtlSeconds } from '../ttl.js';
import type { InMemoryStore } from './InMemoryStore.js';

export class InMemoryGameRepository implements GameRepository {
  constructor(
    readonly store: InMemoryStore<StoredGame>,
    private readonly rooms: InMemoryStore<Room>,
  ) {}

  async get(roomId: string): Promise<StoredGame | null> {
    return this.store.get(roomId);
  }

  /** Also refreshes the room's TTL, so a long game cannot outlive its room. */
  async save(game: StoredGame): Promise<void> {
    this.store.set(game.roomId, game, gameTtlSeconds(game));
    const room = this.rooms.get(game.roomId);
    if (room) this.rooms.touch(game.roomId, roomTtlSeconds(room));
  }

  async replaceKeepingTtl(game: StoredGame): Promise<boolean> {
    return this.store.replace(game.roomId, game);
  }

  async delete(roomId: string): Promise<void> {
    this.store.delete(roomId);
  }
}
