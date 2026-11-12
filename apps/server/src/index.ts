import { buildServer } from './app.js';
import { createBackend } from './backend.js';
import { loadConfig } from './config.js';

const config = loadConfig();

// Logger for the bootstrap phase, before Fastify (and its logger) exists.
const bootLog = {
  info: (obj: object, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj: object, msg: string) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

const backend = await createBackend(config, bootLog);
await backend.startup();

const { app } = buildServer({
  repos: backend.repos,
  corsOrigins: config.corsOrigins,
  logger: true,
  health: () => backend.health(),
  onClose: () => backend.close(),
});
app.log.info({ repository: backend.kind }, 'storage backend ready');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // closes sockets, HTTP, then the backend (Redis)
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await backend.close();
  process.exit(1);
}
