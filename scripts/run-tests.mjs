// Runs every workspace's tests one after another with a hard time limit per workspace, so a
// stuck test run can never hang a terminal or CI job: on expiry the whole process tree is killed
// and the run fails, naming the workspace.
//
//   node scripts/run-tests.mjs [workspace...]      (npm test)
//   TEST_WORKSPACE_TIMEOUT_MS=600000                default 10 min per workspace (normal: < 1 min)
import { spawn, spawnSync } from 'node:child_process';

const ALL = ['packages/shared', 'packages/game-engine', 'apps/server', 'apps/web'];
const workspaces = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;
const limitMs = Number(process.env.TEST_WORKSPACE_TIMEOUT_MS ?? 10 * 60 * 1000);
const isWindows = process.platform === 'win32';

function killTree(pid) {
  if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached)
    } catch {
      /* already gone */
    }
  }
}

function run(workspace) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npm', ['test', `--workspace=${workspace}`], {
      stdio: 'inherit',
      shell: isWindows, // npm is npm.cmd on Windows
      detached: !isWindows,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[run-tests] ${workspace}: no result after ${limitMs / 1000}s, killing it`);
      killTree(child.pid);
    }, limitMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ workspace, code: timedOut ? 124 : (code ?? 1), signal, timedOut, ms: Date.now() - started });
    });
  });
}

const results = [];
for (const workspace of workspaces) results.push(await run(workspace));

console.log('\n[run-tests] summary');
for (const r of results) {
  const status = r.timedOut ? 'TIMED OUT' : r.code === 0 ? 'ok' : `failed (exit ${r.code})`;
  console.log(`  ${r.workspace.padEnd(22)} ${status.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s`);
}
process.exit(results.every((r) => r.code === 0) ? 0 : 1);
