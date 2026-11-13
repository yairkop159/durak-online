import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages from source: no prebuild needed for dev, tests or the production bundle.
    alias: {
      '@durak/shared': source('../../packages/shared/src/index.ts'),
      '@durak/game-engine': source('../../packages/game-engine/src/index.ts'),
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
  },
});
