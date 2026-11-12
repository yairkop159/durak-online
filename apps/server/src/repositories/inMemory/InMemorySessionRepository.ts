import type { Session } from '../../domain/types.js';
import type { SessionRepository } from '../interfaces.js';
import { InMemoryStore } from './InMemoryStore.js';

export class InMemorySessionRepository implements SessionRepository {
  private readonly store = new InMemoryStore<Session>();

  async create(session: Session): Promise<void> {
    this.store.set(session.token, session);
  }

  async get(token: string): Promise<Session | null> {
    return this.store.get(token);
  }

  async delete(token: string): Promise<void> {
    this.store.delete(token);
  }
}
