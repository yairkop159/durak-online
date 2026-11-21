import { ClientEvents, type ClientEventName, type ErrorPayload } from '@durak/shared';
import type { Session } from '../domain/types.js';
import type { GameService } from '../services/GameService.js';
import type { ReactionService } from '../services/ReactionService.js';
import type { RestartVoteService } from '../services/RestartVoteService.js';
import type { RoomService } from '../services/RoomService.js';
import { ConnectionCounter, SlidingWindowLimiter, SocketEventLimiter, type LimitSettings } from './rateLimit.js';
import { toRoomStatePayload } from './SocketNotifier.js';
import { channels, type IoServer, type IoSocket } from './socketTypes.js';
import { parsePayload, type PayloadOf } from './validate.js';

export interface HandlerDeps {
  readonly io: IoServer;
  readonly rooms: RoomService;
  readonly games: GameService;
  readonly votes: RestartVoteService;
  readonly reactions: ReactionService;
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
  /**
   * The profile behind an optional device key (Phase 10), or null: unknown key, Postgres down or
   * slow. Never throws and never blocks a seat for long (bounded timeout).
   */
  readonly resolveProfile: (deviceKey: string | undefined) => Promise<string | null>;
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
    const ip = deps.ipOf(socket);
    if (shared.connections.canOpen(ip)) return next();
    deps.log.warn({ ip, code: 'TOO_MANY_CONNECTIONS' }, 'connection refused');
    next(new Error('TOO_MANY_CONNECTIONS'));
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
  const { io, rooms, games, votes, reactions, log } = deps;
  /**
   * Who this socket is, for log lines: never the session token, never a payload (payloads can
   * carry tokens and are attacker-controlled).
   */
  const who = () => {
    const session = socket.data.session;
    return session
      ? { ip, roomId: session.roomId, playerId: session.id, role: session.role }
      : { ip, roomId: null, playerId: null, role: null };
  };
  /** Every error a client receives goes through here and is logged with its code (only). */
  const sendError = (error: ErrorPayload, event?: string) => {
    log.info({ ...who(), code: error.code, ...(event ? { event } : {}) }, 'error sent to client');
    socket.emit('error', error);
  };

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
        sendError(parsed.error, event);
        return;
      }
      handler(parsed.value).catch((error: unknown) => {
        log.error({ err: error, event }, 'socket handler failed');
        sendError({ code: 'INTERNAL', message: 'Internal server error' }, event);
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

  const unbind = (session: Session) => unbindSocket(socket, session);

  /** Re-sends an existing session instead of creating a second seat for the same connection. */
  const reissue = async (session: Session) => {
    socket.emit('session:issued', { sessionToken: session.token, playerId: session.id, roomId: session.roomId });
    const room = await rooms.getRoom(session.roomId);
    if (room) socket.emit('room:state', toRoomStatePayload(room, deps.now()));
  };

  socket.onAny((event: string) => {
    if (!KNOWN_EVENTS.has(event)) sendError({ code: 'INVALID_PAYLOAD', message: `Unknown event ${event}` }, 'unknown');
  });

  on(ClientEvents.CreateRoom, async (payload) => {
    const existing = socket.data.session;
    if (existing) return reissue(existing);
    if (!shared.roomCreation.canHit(ip)) {
      sendError({ code: 'TOO_MANY_ROOMS', message: 'Too many rooms created from this address, try again later' });
      return;
    }
    const profileId = await deps.resolveProfile(payload.deviceKey);
    // The lookup awaited: another create/join on this socket may have seated it meanwhile.
    const seated = socket.data.session;
    if (seated) return reissue(seated);
    const result = await rooms.createRoom(
      { nickname: payload.nickname, maxPlayers: payload.maxPlayers, config: payload.config, profileId },
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
    const profileId = await deps.resolveProfile(payload.deviceKey);
    const seated = socket.data.session;
    if (seated) {
      if (seated.roomId === payload.roomId) return reissue(seated);
      { sendError({ code: 'INVALID_SESSION', message: 'This connection is already in another room' }); return; }
    }
    const result = await rooms.joinRoom(payload.roomId, payload.nickname, bind, profileId);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.LeaveRoom, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      { sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' }); return; }
    }
    const result = await rooms.leaveRoom(session);
    if (!result.ok) { sendError(result.error); return; }
    // The session is gone: every connection holding it is unbound, not only this one.
    for (const other of io.sockets.sockets.values()) {
      if (other.data.session?.token === session.token) unbindSocket(other, session);
    }
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

  on(ClientEvents.SetTeams, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await rooms.setTeams(session, payload.teams);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.SwapSeats, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await rooms.swapSeats(session, payload.a, payload.b);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.RestartPropose, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await votes.propose(session);
    if (!result.ok) sendError(result.error);
  });

  on(ClientEvents.RestartRespond, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await votes.respond(session, payload.voteId, payload.accept);
    if (!result.ok) sendError(result.error);
  });

  // Ephemeral: no lock, nothing stored. Over the per-player limit the reaction is dropped silently.
  on(ClientEvents.React, async (payload) => {
    const session = socket.data.session;
    if (!session || session.roomId !== payload.roomId) {
      sendError({ code: 'NOT_IN_ROOM', message: 'You are not in this room' });
      return;
    }
    const result = await reactions.react(session, payload.roomId, payload.reactionId);
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
      log.info({ ...who(), code: 'INVALID_SESSION' }, 'session resume failed');
      sendError({ code: 'INVALID_SESSION', message: 'This connection already holds another session' }, 'session:resume');
      return;
    }
    const result = await rooms.resume(payload.sessionToken, bind);
    if (result.ok) {
      log.info(who(), 'session resumed');
    } else {
      log.info({ ...who(), code: result.error.code }, 'session resume failed');
      sendError(result.error, 'session:resume');
    }
  });

  socket.on('disconnect', (reason: string) => {
    log.info({ ...who(), reason, shuttingDown: deps.isShuttingDown() }, 'socket disconnected');
    const session = socket.data.session;
    if (!session || session.role !== 'player' || deps.isShuttingDown()) return;
    const isStillOffline = async () => (await io.in(channels.player(session.id)).fetchSockets()).length === 0;
    rooms.markDisconnected(session, isStillOffline).catch((error: unknown) => {
      log.error({ err: error }, 'disconnect handling failed');
    });
  });
}

function unbindSocket(socket: IoSocket, session: Session): void {
  socket.data.session = null;
  for (const channel of [
    channels.room(session.roomId),
    channels.player(session.id),
    channels.spectators(session.roomId),
    channels.spectator(session.id),
  ]) {
    void socket.leave(channel);
  }
}
