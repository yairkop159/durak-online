import type { Room, Session, StoredGame } from '../domain/types.js';

/**
 * Storage contracts. Everything is async so the Redis implementation (Phase 3b)
 * is a drop-in replacement for the in-memory one.
 */
export interface RoomRepository {
  get(roomId: string): Promise<Room | null>;
  /** Upsert. */
  save(room: Room): Promise<void>;
  delete(roomId: string): Promise<void>;
}

export interface GameRepository {
  get(roomId: string): Promise<StoredGame | null>;
  /** Upsert, keyed by roomId (one active game per room). */
  save(game: StoredGame): Promise<void>;
  delete(roomId: string): Promise<void>;
}

export interface SessionRepository {
  create(session: Session): Promise<void>;
  get(token: string): Promise<Session | null>;
  delete(token: string): Promise<void>;
}

export interface Repositories {
  readonly rooms: RoomRepository;
  readonly games: GameRepository;
  readonly sessions: SessionRepository;
}
