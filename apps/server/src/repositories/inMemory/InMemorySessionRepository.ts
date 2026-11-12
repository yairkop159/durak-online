import type { Session } from '../../domain/types.js';
import type { SessionRepository } from '../interfaces.js';
import { SESSION_TTL_SECONDS } from '../ttl.js';
import type { InMemoryStore } from './InMemoryStore.js';

export class InMemorySessionRepository implements SessionRepository {
  constructor(readonly store: InMemoryStore<Session>) {}

  async create(session: Session): Promise<void> {
    this.store.set(session.token, session, SESSION_TTL_SECONDS);
  }

  /** Sliding expiry: a successful read (session:resume) refreshes the TTL. */
  async get(token: string): Promise<Session | null> {
    return this.store.getAndTouch(token, SESSION_TTL_SECONDS);
  }

  async delete(token: string): Promise<void> {
    this.store.delete(token);
  }
}
