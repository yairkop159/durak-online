import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Use workspace sources so tests never run against a stale build.
    alias: {
      '@durak/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@durak/game-engine': fileURLToPath(new URL('../../packages/game-engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
