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
  /** Every stored room id (Redis: SCAN, never KEYS). Used at startup to re-arm timers. */
  scanIds(): AsyncIterable<string>;
}

export interface GameRepository {
  get(roomId: string): Promise<StoredGame | null>;
  /** Upsert, keyed by roomId (one active game per room). */
  save(game: StoredGame): Promise<void>;
  /**
   * Replaces a stored game WITHOUT touching any TTL (neither the game's nor its room's), unlike
   * `save`, which slides both. Only for annotating a finished game after the fact (its rating
   * outcome): the game-over screen must not live longer because of it. Returns false, writing
   * nothing, when the game key no longer exists (expired or deleted by a rematch).
   */
  replaceKeepingTtl(game: StoredGame): Promise<boolean>;
  delete(roomId: string): Promise<void>;
}

export interface SessionRepository {
  create(session: Session): Promise<void>;
  get(token: string): Promise<Session | null>;
  delete(token: string): Promise<void>;
}

/** Writes that must touch a room and its game together (Redis: one MULTI/EXEC). */
export interface RoomGameTransaction {
  /** Persists both records or neither. */
  saveRoomAndGame(room: Room, game: StoredGame): Promise<void>;
  /** Saves the room and deletes its game, both or neither (rematch: back to the lobby). */
  saveRoomDeleteGame(room: Room): Promise<void>;
  /** Deletes both records or neither. */
  deleteRoomAndGame(roomId: string): Promise<void>;
}

export interface Repositories {
  readonly rooms: RoomRepository;
  readonly games: GameRepository;
  readonly sessions: SessionRepository;
  readonly atomic: RoomGameTransaction;
}
