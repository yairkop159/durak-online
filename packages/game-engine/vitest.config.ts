import { availableParallelism } from 'node:os';
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
    // The property/fuzz tests are long synchronous CPU blocks. Using every core starved Vitest's
    // main process on a busy machine until a worker's RPC timed out ("Timeout calling
    // onTaskUpdate") and the run stalled. Leave half the cores free.
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    testTimeout: 30_000, // the heaviest tests set their own (60-120 s)
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});
