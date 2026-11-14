import { MAX_PLAYERS, type BotDifficulty, type ClientMove, type GameMode, type RoomStatePayload, type SessionIssuedPayload } from '@durak/shared';
import { SessionTokens, type KeyValueStorage } from './sessionStore';
import { Store, canAct, type ClientState } from './store';
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
  /**
   * "Play vs computer": create a room with `bots + 1` seats, then add the bots one at a time (the
   * next `room:addBot` goes out once the previous bot shows up in `room:state`), then start once
   * they are all seated. Driven by `room:state`; any error or leaving cancels it.
   */
  private vsComputer: { readonly difficulty: BotDifficulty; readonly bots: number; requested: number } | null = null;

  constructor(options: GameClientOptions) {
    this.transport = options.transport;
    this.tokens = new SessionTokens(options.storage);
    this.now = options.now ?? Date.now;
    const { transport, store } = this;

    // Resume first: nothing else is emitted on a new socket before it is bound again.
    transport.onConnect(() => {
      store.dispatch({ type: 'connection', status: 'connected' });
      this.tryResume();
    });
    transport.onDisconnect(() => store.dispatch({ type: 'connection', status: 'disconnected' }));
    transport.on('session:issued', (payload) => {
      this.tokens.set(payload.roomId, payload.sessionToken);
      store.dispatch({ type: 'session:issued', payload });
    });
    transport.on('room:state', (payload) => {
      store.dispatch({ type: 'room:state', payload, receivedAt: this.now() });
      this.advanceVsComputer(payload);
    });
    transport.on('game:state', (payload) =>
      store.dispatch({ type: 'game:state', payload, receivedAt: this.now() }),
    );
    transport.on('game:over', (payload) => store.dispatch({ type: 'game:over', payload }));
    transport.on('room:restartVoteEnded', (payload) => store.dispatch({ type: 'restart:ended', payload }));
    transport.on('error', (payload) => {
      if (payload.code !== 'STALE_STATE') this.vsComputer = null;
      const pendingRoom = this.state.resumeStatus === 'pending' ? this.routeRoomId : null;
      store.dispatch({ type: 'error', payload });
      if (pendingRoom !== null && this.state.resumeStatus === 'failed') this.tokens.remove(pendingRoom);
      // NOT_IN_ROOM while we hold a session: the reducer marked us unbound; resume, which also
      // re-sends room:state and game:state (a full resync).
      if (payload.code === 'NOT_IN_ROOM' && this.state.session !== null) this.tryResume();
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

  /** One click to a game against `bots` bots (1-5): room:create -> room:addBot × bots -> game:start. */
  playVsComputer(input: { nickname: string; mode: GameMode; difficulty: BotDifficulty; bots?: number }): void {
    const bots = Math.min(MAX_PLAYERS - 1, Math.max(1, Math.trunc(input.bots ?? 1)));
    this.createRoom({ nickname: input.nickname, maxPlayers: bots + 1, mode: input.mode });
    this.vsComputer = { difficulty: input.difficulty, bots, requested: 0 };
  }

  addBot(difficulty: BotDifficulty): void {
    const session = this.boundSession();
    if (session) this.transport.emit('room:addBot', { roomId: session.roomId, difficulty });
  }

  removeBot(playerId: string): void {
    const session = this.boundSession();
    if (session) this.transport.emit('room:removeBot', { roomId: session.roomId, playerId });
  }

  joinRoom(roomId: string, nickname: string): void {
    this.leaveBindingIfAny(roomId);
    this.transport.emit('room:join', { roomId, nickname });
  }

  leaveRoom(): void {
    const session = this.state.session;
    if (!session) return;
    this.vsComputer = null;
    // From an unbound socket the server would only answer NOT_IN_ROOM; the seat then simply
    // stays offline (and is released by the usual lobby/grace rules).
    if (canAct(this.state)) this.transport.emit('room:leave', { roomId: session.roomId });
    this.tokens.remove(session.roomId);
    this.store.dispatch({ type: 'left' });
  }

  startGame(): void {
    const session = this.boundSession();
    if (session) this.transport.emit('game:start', { roomId: session.roomId });
  }

  /** Proposes a new game (ends the running one if everyone agrees). */
  proposeRestart(): void {
    const session = this.boundSession();
    if (session) this.transport.emit('room:restartPropose', { roomId: session.roomId });
  }

  respondRestart(voteId: string, accept: boolean): void {
    const session = this.boundSession();
    if (session) this.transport.emit('room:restartRespond', { roomId: session.roomId, voteId, accept });
  }

  dismissNotice(): void {
    this.store.dispatch({ type: 'dismissNotice' });
  }

  rematch(): void {
    const session = this.boundSession();
    if (session) this.transport.emit('room:rematch', { roomId: session.roomId });
  }

  /**
   * Sends a move against the last game version we received. Dropped while disconnected or
   * resuming: the socket isn't bound to our seat yet (the server would answer NOT_IN_ROOM), and
   * socket.io would otherwise buffer it and flush it BEFORE the resume on the next connect.
   */
  sendMove(move: ClientMove): void {
    const game = this.state.game;
    if (!game || !canAct(this.state)) return;
    this.transport.emit('game:move', { roomId: game.roomId, move, expectedVersion: game.version });
  }

  dismissError(): void {
    this.store.dispatch({ type: 'dismissError' });
  }

  close(): void {
    this.transport.close();
  }

  private advanceVsComputer(room: RoomStatePayload): void {
    const intent = this.vsComputer;
    const session = this.state.session;
    if (!intent || !session || room.roomId !== session.roomId || room.hostId !== session.playerId) return;
    if (room.status !== 'lobby') {
      this.vsComputer = null;
      return;
    }
    const seated = room.members.filter((m) => m.isBot).length;
    if (seated >= intent.bots) {
      this.vsComputer = null;
      this.transport.emit('game:start', { roomId: room.roomId });
    } else if (seated === intent.requested && room.members.length < room.maxPlayers) {
      // The last requested bot is seated (or none was requested yet): ask for the next one.
      intent.requested += 1;
      this.transport.emit('room:addBot', { roomId: room.roomId, difficulty: intent.difficulty });
    } else if (room.members.length >= room.maxPlayers) {
      this.vsComputer = null; // someone else took the free seat: leave it to the lobby
    }
  }

  /** The session, if this connection is bound to it and may act. */
  private boundSession(): SessionIssuedPayload | null {
    return canAct(this.state) ? this.state.session : null;
  }

  /**
   * Binds this connection to the route's stored session. Runs on EVERY connect, socket.io's
   * automatic reconnects included: the server binds sessions per socket, so a new socket must
   * resume even though we still hold the session from the previous one.
   */
  private tryResume(): void {
    const roomId = this.routeRoomId;
    if (roomId === null || !this.transport.connected) return;
    const { session, bound, resumeStatus } = this.state;
    if (resumeStatus === 'pending') return;
    if (session?.roomId === roomId && bound) return;
    const token = this.tokens.get(roomId) ?? (session?.roomId === roomId ? session.sessionToken : null);
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
