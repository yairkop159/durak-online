import type { Room } from '../../domain/types.js';
import type { RoomRepository } from '../interfaces.js';
import { InMemoryStore } from './InMemoryStore.js';

export class InMemoryRoomRepository implements RoomRepository {
  private readonly store = new InMemoryStore<Room>();

  async get(roomId: string): Promise<Room | null> {
    return this.store.get(roomId);
  }

  async save(room: Room): Promise<void> {
    this.store.set(room.id, room);
  }

  async delete(roomId: string): Promise<void> {
    this.store.delete(roomId);
  }
}
