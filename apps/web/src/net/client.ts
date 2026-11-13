import type { ClientMove, GameMode } from '@durak/shared';
import { SessionTokens, type KeyValueStorage } from './sessionStore';
import { Store, type ClientState } from './store';
import type { Transport } from './transport';

export interface GameClientOptions {
  readonly transport: Transport;
  readonly storage: KeyValueStorage | null;
  readonly now?: () => number;
}

/**
 * The one connection to the server: feeds every server event into the store, keeps session
 * tokens, resumes automatically on (re)connect, and exposes the client -> server actions.
 */
export class GameClient {
  readonly store = new Store();
  private readonly transport: Transport;
  private readonly tokens: SessionTokens;
  /** Local clock; stamps `receivedAt` and drives countdowns. */
  readonly now: () => number;
  /** The room shown by the current route (`/room/:id`), or null on the home screen. */
  private routeRoomId: string | null = null;

  constructor(options: GameClientOptions) {
    this.transport = options.transport;
    this.tokens = new SessionTokens(options.storage);
    this.now = options.now ?? Date.now;
    const { transport, store } = this;

    transport.onConnect(() => {
      store.dispatch({ type: 'connection', status: 'connected' });
      this.tryResume();
    });
    transport.onDisconnect(() => store.dispatch({ type: 'connection', status: 'disconnected' }));
    transport.on('session:issued', (payload) => {
      this.tokens.set(payload.roomId, payload.sessionToken);
      store.dispatch({ type: 'session:issued', payload });
    });
    transport.on('room:state', (payload) => store.dispatch({ type: 'room:state', payload }));
    transport.on('game:state', (payload) =>
      store.dispatch({ type: 'game:state', payload, receivedAt: this.now() }),
    );
    transport.on('game:over', (payload) => store.dispatch({ type: 'game:over', payload }));
    transport.on('error', (payload) => {
      const pendingRoom = this.state.resumeStatus === 'pending' ? this.routeRoomId : null;
      store.dispatch({ type: 'error', payload });
      if (pendingRoom !== null && this.state.resumeStatus === 'failed') this.tokens.remove(pendingRoom);
    });
    if (transport.connected) store.dispatch({ type: 'connection', status: 'connected' });
  }

  get state(): ClientState {
    return this.store.getState();
  }

  /** Called by the router. Entering a room's URL resumes its stored session, if any. */
  setRoute(roomId: string | null): void {
    if (roomId === this.routeRoomId) return;
    this.routeRoomId = roomId;
    const session = this.state.session;
    if (session && session.roomId !== roomId) {
      // Navigated away from the room we were bound to (e.g. browser back): start clean.
      this.store.dispatch({ type: 'left' });
      this.transport.reconnect();
      return; // the reconnect's onConnect will resume the new route's session
    }
    if (!session) {
      if (this.state.room || this.state.roomNotFound || this.state.resumeStatus !== 'idle') {
        this.store.dispatch({ type: 'left' });
      }
      this.tryResume();
    }
  }

  hasStoredSession(roomId: string): boolean {
    return this.tokens.get(roomId) !== null;
  }

  createRoom(input: { nickname: string; maxPlayers: number; mode: GameMode }): void {
    this.leaveBindingIfAny();
    this.transport.emit('room:create', {
      nickname: input.nickname,
      maxPlayers: input.maxPlayers,
      config: { mode: input.mode },
    });
  }

  joinRoom(roomId: string, nickname: string): void {
    this.leaveBindingIfAny(roomId);
    this.transport.emit('room:join', { roomId, nickname });
  }

  leaveRoom(): void {
    const session = this.state.session;
    if (!session) return;
    this.transport.emit('room:leave', { roomId: session.roomId });
    this.tokens.remove(session.roomId);
    this.store.dispatch({ type: 'left' });
  }

  startGame(): void {
    const session = this.state.session;
    if (session) this.transport.emit('game:start', { roomId: session.roomId });
  }

  rematch(): void {
    const session = this.state.session;
    if (session) this.transport.emit('room:rematch', { roomId: session.roomId });
  }

  /** Sends a move against the last game version we received. */
  sendMove(move: ClientMove): void {
    const game = this.state.game;
    if (!game) return;
    this.transport.emit('game:move', { roomId: game.roomId, move, expectedVersion: game.version });
  }

  dismissError(): void {
    this.store.dispatch({ type: 'dismissError' });
  }

  close(): void {
    this.transport.close();
  }

  private tryResume(): void {
    const roomId = this.routeRoomId;
    if (roomId === null || !this.transport.connected || this.state.session?.roomId === roomId) return;
    const token = this.tokens.get(roomId);
    if (token === null) return;
    this.store.dispatch({ type: 'resume:start' });
    this.transport.emit('session:resume', { sessionToken: token });
  }

  /**
   * A connection holds one session. Before creating/joining a different room, drop the old
   * binding by reconnecting (emits are buffered until the new connection is up).
   */
  private leaveBindingIfAny(targetRoomId?: string): void {
    const session = this.state.session;
    if (!session || session.roomId === targetRoomId) return;
    this.store.dispatch({ type: 'left' });
    this.transport.reconnect();
  }
}
