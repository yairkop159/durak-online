import { ClientEvents, type ClientEventName, type ErrorPayload } from '@durak/shared';
import type { Session } from '../domain/types.js';
import type { GameService } from '../services/GameService.js';
import type { RoomService } from '../services/RoomService.js';
import { ConnectionCounter, SlidingWindowLimiter, SocketEventLimiter, type LimitSettings } from './rateLimit.js';
import { toRoomStatePayload } from './SocketNotifier.js';
import { channels, type IoServer, type IoSocket } from './socketTypes.js';
import { parsePayload, type PayloadOf } from './validate.js';

export interface HandlerDeps {
  readonly io: IoServer;
  readonly rooms: RoomService;
  readonly games: GameService;
  readonly log: {
    error: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
  };
  /** During server shutdown, disconnects are ours and must not start reconnection graces. */
  readonly isShuttingDown: () => boolean;
  readonly limits: LimitSettings;
  /** Time source for the limiters (the server clock; tests inject a fake one). */
  readonly now: () => number;
  /** The client address of a connection (honors the reverse-proxy settings). */
  readonly ipOf: (socket: IoSocket) => string;
}

const KNOWN_EVENTS = new Set<string>(Object.values(ClientEvents));
const HOUR_MS = 60 * 60 * 1000;

interface SharedLimiters {
  readonly connections: ConnectionCounter;
  readonly roomCreation: SlidingWindowLimiter;
}

export function registerHandlers(deps: HandlerDeps): void {
  const shared: SharedLimiters = {
    connections: new ConnectionCounter(deps.limits.socketsPerIp),
    roomCreation: new SlidingWindowLimiter(deps.limits.roomsPerIpPerHour, HOUR_MS, deps.now),
  };

  // Refuse the handshake (client gets connect_error "TOO_MANY_CONNECTIONS", no retry loop).
  deps.io.use((socket, next) => {
    if (shared.connections.canOpen(deps.ipOf(socket))) next();
    else next(new Error('TOO_MANY_CONNECTIONS'));
  });

  deps.io.on('connection', (socket) => {
    const ip = deps.ipOf(socket);
    // The derived client address (after TRUST_PROXY), as the per-IP limits see it.
    deps.log.info({ ip, transport: socket.conn.transport.name }, 'socket connected');
    shared.connections.open(ip);
    socket.once('disconnect', () => shared.connections.close(ip));
    socket.data.session = null;
    attach(socket, ip, deps, shared);
  });
}

function attach(socket: IoSocket, ip: string, deps: HandlerDeps, shared: SharedLimiters): void {
  const { io, rooms, games, log } = deps;
  const sendError = (error: ErrorPayload) => socket.emit('error', error);

  // Rate limit every incoming event (known or not) before validation or any handler runs.
  const limiter = new SocketEventLimiter(deps.limits, deps.now);
  socket.use((_packet, next) => {
    // Packets already buffered when a flooder was kicked still arrive here: drop them quietly.
    if (!socket.connected) return;
    const check = limiter.check();
    if (check.verdict === 'allow') {
      next();
    } else if (check.verdict === 'disconnect') {
      log.warn({ ip }, 'socket flooding: disconnected');
      socket.disconnect(true);
    } else if (check.notify) {
      sendError({ code: 'RATE_LIMITED', message: 'Too many events, slow down' });
    }
    // Dropped: `next` is never called, so no handler sees the event.
  });

  /** Every handler: validate first, never throw past this point. */
  const on = <E extends ClientEventName>(
    event: E,
    handler: (payload: PayloadOf<E>) => Promise<void>,
  ) => {
    // Cast: the raw argument is untrusted input, whatever the typed event map says.
    (socket.on as (ev: string, listener: (raw: unknown) => void) => void)(event, (raw: unknown) => {
      const parsed = parsePayload(event, raw);
      if (!parsed.ok) {
        sendError(parsed.error);
        return;
      }
      handler(parsed.value).catch((error: unknown) => {
        log.error({ err: error, event }, 'socket handler failed');
        sendError({ code: 'INTERNAL', message: 'Internal server error' });
      });
    });
  };

  const bind = (session: Session) => {
    socket.data.session = session;
    void socket.join(channels.room(session.roomId));
    if (session.role === 'player') {
      void socket.join(channels.player(session.id));
    } else {
      void socket.join([channels.spectators(session.roomId), channels.spectator(session.id)]);
    }
    socket.emit('session:issued', { sessionToken: session.token, playerId: session.id, roomId: session.roomId });
  };

  const unbind = (session: Session) => {
    socket.data.session = null;
    for (const channel of [
      channels.room(session.roomId),
      channels.player(session.id),
      channels.spectators(session.roomId),
      channels.spectator(session.id),
    ]) {
      void socket.leave(channel);
    }
  };

  /** Re-sends an existing session instead of creating a second seat for the same connection. */
  const reissue = async (session: Session) => {
    socket.emit('session:issued', { sessionToken: session.token, playerId: session.id, roomId: session.roomId });
    const room = await rooms.getRoom(session.roomId);
    if (room) socket.emit('room:state', toRoomStatePayload(room));
  };

  socket.onAny((event: string) => {
    if (!KNOWN_EVENTS.has(event)) sendError({ code: 'INVALID_PAYLOAD', message: `Unknown event ${event}` });
  });

  on(ClientEvents.CreateRoom, async (payload) => {
    const existing = socket.data.session;
    if (existing) return reissue(existing);
    if (!shared.roomCreation.canHit(ip)) {
      sendError({ code: 'TOO_MANY_ROOMS', message: 'Too many rooms created from this address, try again later' });
      return;
    }
    const result = await rooms.createRoom(
      { nickname: payload.nickname, maxPlayers: payload.maxPlayers, config: payload.config },
      bind,
    );
    if (result.ok) shared.roomCreation.record(ip);
    else sendError(result.error);
  });

  on(ClientEvents.JoinRoom, async (payload) => {
    const existing = socket.data.session;
    if (existing) {
      if (existing.roomId === payload.roomId) return reissue(existing);
      { sendError({ code: 'INVALID_SESSION', message: 'This connection is already in another room' }); return; }
    }
    const result = await rooms.joinRoom(payload.roomId, payload.nickname, bind);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.LeaveRoom, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      { sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' }); return; }
    }
    const result = await rooms.leaveRoom(session);
    if (!result.ok) { sendError(result.error); return; }
    unbind(session);
  });

  on(ClientEvents.StartGame, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      { sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' }); return; }
    }
    const result = await rooms.startGame(session);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.Rematch, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await rooms.rematch(session);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.AddBot, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await rooms.addBot(session, payload.difficulty);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.RemoveBot, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await rooms.removeBot(session, payload.playerId);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.MakeMove, async (payload) => {
    const session = socket.data.session;
    if (!session) { sendError({ code: 'NOT_IN_ROOM', message: 'You are not in a room' }); return; }
    const result = await games.makeMove(session, payload.roomId, payload.move, payload.expectedVersion);
    if (result.ok) return;
    sendError(result.error);
    if (result.error.code === 'STALE_STATE') await games.resync(session);
  });

  on(ClientEvents.ResumeSession, async (payload) => {
    const existing = socket.data.session;
    if (existing && existing.token !== payload.sessionToken) {
      { sendError({ code: 'INVALID_SESSION', message: 'This connection already holds another session' }); return; }
    }
    const result = await rooms.resume(payload.sessionToken, bind);
    if (!result.ok) sendError(result.error);
  });

  socket.on('disconnect', () => {
    const session = socket.data.session;
    if (!session || session.role !== 'player' || deps.isShuttingDown()) return;
    const isStillOffline = async () => (await io.in(channels.player(session.id)).fetchSockets()).length === 0;
    rooms.markDisconnected(session, isStillOffline).catch((error: unknown) => {
      log.error({ err: error }, 'disconnect handling failed');
    });
  });
}
