import { afterEach, beforeEach } from 'vitest';

/**
 * Why this file exists ("Timeout calling onTaskUpdate"):
 *
 * Vitest's runner goes from one test to the next with `await`, which only drains microtasks. When
 * the tests are synchronous CPU blocks (the fuzz and bot property tests), the worker's event loop
 * never reaches its poll phase for the whole file, so it cannot read the main process's replies to
 * its RPC calls. birpc's 60 s timer for `onTaskUpdate` then fires as soon as the loop turns
 * (timers run before poll), even though the reply is already waiting. Any file whose tests add
 * up to more than 60 s of synchronous work failed the run this way, however idle the machine.
 *
 * 1. Yield one macrotask before every test, so pending RPC replies are processed in between.
 * 2. Fail any single test that blocks for longer than MAX_SYNC_TEST_MS: a block that long can still
 *    starve the RPC on a slow machine. Split such a test into smaller ones (see fuzz.*.test.ts).
 */
export const MAX_SYNC_TEST_MS = 20_000;

let startedAt = 0;

beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  startedAt = performance.now();
});

afterEach((context) => {
  const ms = performance.now() - startedAt;
  if (ms > MAX_SYNC_TEST_MS) {
    throw new Error(
      `"${context.task.name}" ran for ${Math.round(ms)} ms (limit ${MAX_SYNC_TEST_MS} ms). ` +
        'Split it into smaller tests: long synchronous blocks starve Vitest\'s worker RPC (tests/setup/eventLoop.ts).',
    );
  }
});
