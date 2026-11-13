import type { ClientToServerEvents, ServerToClientEvents } from '@durak/shared';
import { io, type Socket } from 'socket.io-client';

type ServerEvent = keyof ServerToClientEvents;
type ClientEvent = keyof ClientToServerEvents;

/**
 * What the client needs from a socket. The real one wraps socket.io-client;
 * tests use `FakeTransport` and inspect what was emitted.
 */
export interface Transport {
  readonly connected: boolean;
  onConnect(listener: () => void): void;
  onDisconnect(listener: () => void): void;
  on<E extends ServerEvent>(event: E, listener: ServerToClientEvents[E]): void;
  emit<E extends ClientEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]): void;
  /** Drops the connection (and the server-side session binding) and opens a new one. */
  reconnect(): void;
  close(): void;
}

/** The dev server (`npm run dev`): Vite on 5173, the game server on 3000. */
export const DEV_SERVER_URL = 'http://localhost:3000';

/**
 * `VITE_SERVER_URL` (build time) wins. Otherwise a production build talks to the origin that
 * served it (the server hosts the client and Socket.io together), and dev mode to localhost:3000.
 */
export function serverUrl(
  env: { readonly VITE_SERVER_URL?: unknown; readonly DEV?: boolean } = import.meta.env,
  origin: string = globalThis.location?.origin ?? DEV_SERVER_URL,
): string {
  const fromEnv = env.VITE_SERVER_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return env.DEV ? DEV_SERVER_URL : origin;
}

export function socketTransport(url: string, options: { websocketOnly?: boolean } = {}): Transport {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    autoConnect: true,
    ...(options.websocketOnly ? { transports: ['websocket'], forceNew: true } : {}),
  });
  // socket.io's overloaded generic signatures don't line up with a mapped type; the event maps
  // are the same on both sides, so these casts only bridge the typing.
  const on = socket.on.bind(socket) as unknown as (event: string, listener: (...args: never[]) => void) => void;
  const emit = socket.emit.bind(socket) as unknown as (event: string, payload: unknown) => void;
  return {
    get connected() {
      return socket.connected;
    },
    onConnect: (listener) => socket.on('connect', listener),
    onDisconnect: (listener) => socket.on('disconnect', () => listener()),
    on: (event, listener) => on(event, listener as (...args: never[]) => void),
    emit: (event, payload) => emit(event, payload),
    reconnect: () => {
      socket.disconnect();
      socket.connect();
    },
    close: () => socket.disconnect(),
  };
}
