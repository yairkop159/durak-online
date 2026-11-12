import Fastify, { type FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { DEFAULT_CORS_ORIGINS } from './config.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories } from './repositories/inMemory/index.js';
import { GameService } from './services/GameService.js';
import { KeyedMutex } from './services/KeyedMutex.js';
import { cryptoSeedSource, type SeedSource } from './services/random.js';
import { RoomService } from './services/RoomService.js';
import { registerHandlers } from './transport/registerHandlers.js';
import { SocketNotifier } from './transport/SocketNotifier.js';
import type { IoServer } from './transport/socketTypes.js';

/** Max size of a single incoming Socket.io message. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export interface BuildServerOptions {
  readonly repos?: Repositories;
  readonly seedSource?: SeedSource;
  readonly corsOrigins?: readonly string[];
  readonly logger?: boolean;
  readonly now?: () => number;
}

export interface DurakServer {
  readonly app: FastifyInstance;
  readonly io: IoServer;
  readonly repos: Repositories;
  readonly rooms: RoomService;
  readonly games: GameService;
}

export function buildServer(options: BuildServerOptions = {}): DurakServer {
  const app = Fastify({ logger: options.logger ?? false });
  const repos = options.repos ?? createInMemoryRepositories();

  const io: IoServer = new Server(app.server, {
    cors: { origin: [...(options.corsOrigins ?? DEFAULT_CORS_ORIGINS)] },
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
  });

  const mutex = new KeyedMutex();
  const notifier = new SocketNotifier(io);
  const now = options.now ?? Date.now;
  const rooms = new RoomService({ repos, mutex, notifier, seedSource: options.seedSource ?? cryptoSeedSource, now });
  const games = new GameService({ repos, mutex, notifier });

  registerHandlers({ io, rooms, games, log: app.log });

  app.get('/health', async () => ({ status: 'ok' }));

  // Drop socket connections first so the HTTP server can close promptly.
  app.addHook('preClose', async () => {
    io.disconnectSockets(true);
    io.engine.close();
  });

  return { app, io, repos, rooms, games };
}
