import type { Room } from '../../domain/types.js';
import type { RoomRepository } from '../interfaces.js';
import { roomTtlSeconds } from '../ttl.js';
import type { InMemoryStore } from './InMemoryStore.js';

export class InMemoryRoomRepository implements RoomRepository {
  constructor(readonly store: InMemoryStore<Room>) {}

  async get(roomId: string): Promise<Room | null> {
    return this.store.get(roomId);
  }

  async save(room: Room): Promise<void> {
    this.store.set(room.id, room, roomTtlSeconds(room));
  }

  async delete(roomId: string): Promise<void> {
    this.store.delete(roomId);
  }

  async *scanIds(): AsyncIterable<string> {
    yield* this.store.keys();
  }
}
