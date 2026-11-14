import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve the shared package from source so tests never depend on a stale build.
    alias: {
      '@durak/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The property/fuzz tests are long synchronous CPU blocks. This setup yields to the event loop
    // between tests, so the worker's RPC with Vitest's main process never times out ("Timeout
    // calling onTaskUpdate"), and it fails any single test that blocks for more than 20 s. See the
    // file for the full explanation. Workers: Vitest's default (cores - 1).
    setupFiles: ['tests/setup/eventLoop.ts'],
    testTimeout: 30_000, // the heaviest tests set their own (60 s)
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});
