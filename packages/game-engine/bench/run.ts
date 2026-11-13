/**
 * IS-MCTS benchmark (not part of the unit tests).
 *
 *   npm run bench --workspace=packages/game-engine                 quick: 100 games per config
 *   npm run bench --workspace=packages/game-engine -- --full       500 games per config
 *   npm run bench --workspace=packages/game-engine -- --realtime   2 players vs Greedy at a real 300 ms deadline
 *
 * Options:
 *   --games N            games per config (default 100, --full 500, --realtime 500)
 *   --players 2,3        player counts (default 2,3,4; --realtime 2)
 *   --opponents greedy   random and/or greedy (default both; --realtime greedy)
 *   --modes podkidnoy    podkidnoy and/or perevodnoy (default both)
 *   --workers N          worker threads (default: all cores; --realtime 1)
 *   --ms N               time budget for calibration and --realtime (default 300)
 *   --out FILE           results file (default bench/results/<iterations|realtime>-<ms>ms.jsonl)
 *   --fresh              discard the results file and start over
 *
 * Matrix (quick / --full): players x modes x opponents. One IS-MCTS seat against n-1 copies of the
 * opponent, the IS-MCTS seat rotating over every seat, fixed seeds. The search budget is a fixed
 * ITERATION count, calibrated to about --ms per move on this machine, so the results are reproducible.
 *
 * Resumable: every finished game is appended to the results file (JSON lines) together with the
 * calibration. A rerun with the same file reuses the stored calibration and skips the games it
 * already holds, so an interrupted run loses at most the games in flight. Quick and --full share a
 * file (same seeds and budget), so --full after a quick run only plays the extra games.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { GameMode } from '@durak/shared';
import { searchBotMove } from '../src/bot/ismcts.js';
import { canonicalActor } from '../src/bot/turnOrder.js';
import { GreedyBot, createGame, createRng, getLegalMovesForView, initKnowledge, sanitizeStateForPlayer, applyMove } from '../src/index.js';
import { formatCi, median, pct, wilson } from './stats.js';
import type { GameOutcome, GameTask } from './worker.js';

type Opponent = 'random' | 'greedy';
const MODES: readonly GameMode[] = ['podkidnoy', 'perevodnoy'];
const OPPONENTS: readonly Opponent[] = ['random', 'greedy'];

interface Args {
  full: boolean;
  realtime: boolean;
  fresh: boolean;
  games: number | null;
  workers: number | null;
  ms: number;
  players: number[] | null;
  opponents: Opponent[] | null;
  modes: GameMode[] | null;
  out: string | null;
}

function parseList<T extends string | number>(
  flag: string,
  raw: string | undefined,
  allowed: readonly T[],
  parse: (s: string) => T,
): T[] {
  if (raw === undefined) throw new Error(`${flag} needs a comma-separated list`);
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parse);
  for (const item of items) {
    if (!allowed.includes(item)) throw new Error(`${flag}: ${item} is not one of ${allowed.join(', ')}`);
  }
  if (items.length === 0) throw new Error(`${flag} needs at least one value`);
  return [...new Set(items)];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    full: false,
    realtime: false,
    fresh: false,
    games: null,
    workers: null,
    ms: 300,
    players: null,
    opponents: null,
    modes: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} needs a positive number`);
      return v;
    };
    if (a === '--full') args.full = true;
    else if (a === '--realtime') args.realtime = true;
    else if (a === '--fresh') args.fresh = true;
    else if (a === '--games') args.games = Math.floor(num());
    else if (a === '--workers') args.workers = Math.floor(num());
    else if (a === '--ms') args.ms = num();
    else if (a === '--players') args.players = parseList(a, argv[++i], [2, 3, 4, 5, 6], Number);
    else if (a === '--opponents') args.opponents = parseList(a, argv[++i], OPPONENTS, (s) => s as Opponent);
    else if (a === '--modes') args.modes = parseList(a, argv[++i], MODES, (s) => s as GameMode);
    else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out needs a file path');
      args.out = v;
    } else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Results file (JSON lines): calibration records and one record per finished game
// ---------------------------------------------------------------------------

type ResultRecord =
  | { readonly type: 'calibration'; readonly players: number; readonly ms: number; readonly iterations: number; readonly samples: number }
  | { readonly type: 'game'; readonly key: string; readonly outcome: GameOutcome };

/** Identifies a game across runs: same key = same game with the same budget, so a stored outcome can be reused. */
function taskKey(t: GameTask): string {
  const budget = t.budget.kind === 'iterations' ? `it${t.budget.iterations}` : `ms${t.budget.ms}`;
  return `${t.players}p|${t.mode}|${t.opponent}|${budget}|seed${t.seed}|seat${t.ismctsSeat}`;
}

function loadResults(file: string): ResultRecord[] {
  if (!existsSync(file)) return [];
  const records: ResultRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as ResultRecord);
    } catch {
      // A line cut off by an interrupted run: that game is simply played again.
    }
  }
  return records;
}

function appendResult(file: string, record: ResultRecord): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Iterations IS-MCTS completes in `ms` on typical decisions (opening and mid-game), single-threaded. */
function calibrate(players: number, ms: number): { iterations: number; samples: number } {
  const counts: number[] = [];
  for (let seed = 1; seed <= 4; seed++) {
    const created = createGame({ playerIds: Array.from({ length: players }, (_, i) => `p${i}`), seed: 9000 + seed });
    if (!created.ok) throw new Error(created.error.message);
    let state = created.value;
    const rng = createRng(seed);
    for (let step = 0; step < 24 && state.phase.kind !== 'finished'; step++) {
      const seat = canonicalActor(state);
      const id = state.players[seat]!.id;
      const view = sanitizeStateForPlayer(state, id);
      const knowledge = initKnowledge(view);
      if (step % 8 === 0 && getLegalMovesForView(view).length > 1) {
        const t0 = performance.now();
        const result = searchBotMove(view, knowledge, { seed, budget: { deadlineMs: t0 + ms, now: () => performance.now() } });
        counts.push(result.iterations);
      }
      const move = GreedyBot.choose(view, knowledge, rng);
      if (!move) break;
      const next = applyMove(state, { ...move, playerId: id });
      if (!next.ok) throw new Error(next.error.message);
      state = next.value;
    }
  }
  return { iterations: Math.max(1, Math.round(median(counts))), samples: counts.length };
}

interface Config {
  readonly id: number;
  readonly players: number;
  readonly mode: GameMode;
  readonly opponent: Opponent;
  readonly games: number;
  readonly budget: GameTask['budget'];
}

async function runAll(
  tasks: readonly GameTask[],
  workers: number,
  onOutcome: (task: GameTask, outcome: GameOutcome, done: number) => void,
): Promise<GameOutcome[]> {
  const outcomes: GameOutcome[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, tasks.length) }, () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL('./worker.ts', import.meta.url));
        let current: GameTask | undefined;
        const feed = () => {
          current = tasks[next++];
          if (current) worker.postMessage(current);
          else worker.postMessage('done');
        };
        worker.on('message', (outcome: GameOutcome) => {
          outcomes.push(outcome);
          onOutcome(current!, outcome, outcomes.length);
          feed();
        });
        worker.on('error', reject);
        worker.on('exit', () => resolve());
        feed();
      }),
    ),
  );
  return outcomes;
}

function report(configs: readonly Config[], outcomes: readonly GameOutcome[]): string[] {
  const lines: string[] = [];
  const header =
    'players  mode        vs       games  IS-MCTS durak [95% CI]   opponent durak/seat [95% CI]  fair    draws  aband.  budget        it/s    ms/search  ms/move';
  lines.push(header, '-'.repeat(header.length));
  const verdicts: string[] = [];
  for (const cfg of configs) {
    const os = outcomes.filter((o) => o.configId === cfg.id);
    const games = os.length;
    const mctsDurak = os.filter((o) => o.durakSeat === o.ismctsSeat).length;
    const oppDurak = os.filter((o) => o.durakSeat !== null && o.durakSeat !== o.ismctsSeat).length;
    const draws = os.filter((o) => o.durakSeat === null && !o.abandoned).length;
    const abandoned = os.filter((o) => o.abandoned).length;
    const oppSeats = games * (cfg.players - 1);
    const iterations = os.reduce((n, o) => n + o.iterations, 0);
    const searchMs = os.reduce((n, o) => n + o.searchMs, 0);
    const searches = os.reduce((n, o) => n + o.searches, 0);
    const decisions = os.reduce((n, o) => n + o.decisions, 0);
    const decisionMs = os.reduce((n, o) => n + o.decisionMs, 0);
    const budget = cfg.budget.kind === 'iterations' ? `${cfg.budget.iterations} it` : `${cfg.budget.ms} ms`;
    lines.push(
      [
        String(cfg.players).padEnd(8),
        cfg.mode.padEnd(11),
        cfg.opponent.padEnd(8),
        String(games).padStart(5),
        ' ',
        formatCi(mctsDurak, games).padEnd(24),
        formatCi(oppDurak, oppSeats).padEnd(29),
        pct(1 / cfg.players).padEnd(7),
        String(draws).padStart(5),
        String(abandoned).padStart(7),
        ' ',
        budget.padEnd(10),
        String(Math.round(iterations / Math.max(1e-9, searchMs / 1000))).padStart(8),
        (searchMs / Math.max(1, searches)).toFixed(1).padStart(10),
        (decisionMs / Math.max(1, decisions)).toFixed(1).padStart(9),
      ].join(' '),
    );
    if (cfg.players === 2 && cfg.opponent === 'greedy') {
      const m = wilson(mctsDurak, games);
      const g = wilson(oppDurak, games);
      const pass = m.hi < g.lo;
      verdicts.push(
        `${pass ? 'PASS' : 'FAIL'}  2p ${cfg.mode} vs greedy (${budget}): IS-MCTS durak ${pct(m.p)} [${pct(m.lo)}, ${pct(m.hi)}] vs greedy ${pct(g.p)} [${pct(g.lo)}, ${pct(g.hi)}]${pass ? ' (non-overlapping)' : ' (overlapping)'}`,
      );
    }
  }
  lines.push('', 'Opponent durak rate is per opponent seat (the opponents in one game are not independent samples).');
  lines.push('ms/search = IS-MCTS decisions with more than one legal move; ms/move = all IS-MCTS decisions.');
  if (verdicts.length) lines.push('', 'Target (2 players, IS-MCTS clearly better than Greedy):', ...verdicts);
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const cores = availableParallelism();
  const kind = args.realtime ? 'realtime' : 'iterations';
  const file = args.out ?? fileURLToPath(new URL(`./results/${kind}-${args.ms}ms.jsonl`, import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  if (args.fresh) rmSync(file, { force: true });

  const players = args.players ?? (args.realtime ? [2] : [2, 3, 4]);
  const opponents: Opponent[] = args.opponents ?? (args.realtime ? ['greedy'] : [...OPPONENTS]);
  const modes = args.modes ?? [...MODES];
  const games = args.games ?? (args.realtime || args.full ? 500 : 100);

  const stored = loadResults(file);
  console.log(`Results file: ${file} (${stored.filter((r) => r.type === 'game').length} stored games)`);

  // Calibration: reuse the stored value per player count, so a resumed run keeps the same budget.
  console.log(`Calibration: iterations per ${args.ms} ms (single-threaded, median over sample decisions)`);
  const calibration = new Map<number, number>();
  for (const r of stored) if (r.type === 'calibration' && r.ms === args.ms) calibration.set(r.players, r.iterations);
  for (const n of players) {
    const known = calibration.get(n);
    if (known !== undefined) {
      console.log(`  ${n} players: ${known} iterations ≈ ${args.ms} ms  (stored)`);
      continue;
    }
    const { iterations, samples } = calibrate(n, args.ms);
    calibration.set(n, iterations);
    appendResult(file, { type: 'calibration', players: n, ms: args.ms, iterations, samples });
    console.log(`  ${n} players: ${iterations} iterations ≈ ${args.ms} ms  (${samples} samples)`);
  }

  const configs: Config[] = [];
  for (const n of players) {
    for (const mode of modes) {
      for (const opponent of opponents) {
        configs.push({
          id: configs.length,
          players: n,
          mode,
          opponent,
          games,
          budget: args.realtime ? { kind: 'deadline', ms: args.ms } : { kind: 'iterations', iterations: calibration.get(n)! },
        });
      }
    }
  }

  const tasks: GameTask[] = configs.flatMap((cfg) =>
    Array.from({ length: cfg.games }, (_, i) => ({
      configId: cfg.id,
      players: cfg.players,
      mode: cfg.mode,
      opponent: cfg.opponent,
      seed: 100_000 * (cfg.players * 10 + (cfg.mode === 'perevodnoy' ? 1 : 0)) + i,
      ismctsSeat: i % cfg.players,
      budget: cfg.budget,
    })),
  );

  // Reuse stored outcomes (re-labelled with this run's config ids); play only the missing games.
  const storedByKey = new Map<string, GameOutcome>();
  for (const r of stored) if (r.type === 'game') storedByKey.set(r.key, r.outcome);
  const reused: GameOutcome[] = [];
  const todo: GameTask[] = [];
  for (const task of tasks) {
    const hit = storedByKey.get(taskKey(task));
    if (hit) reused.push({ ...hit, configId: task.configId });
    else todo.push(task);
  }

  // Real-time runs default to one worker so the deadlines don't compete for cores.
  const workers = args.workers ?? (args.realtime ? 1 : Math.max(1, cores));
  console.log(
    `\n${args.realtime ? 'Realtime' : games >= 500 ? 'Full' : 'Quick'} run: ${configs.length} configs, ${tasks.length} games ` +
      `(${reused.length} already in the results file, ${todo.length} to play), ${workers} worker(s) (${cores} cores)`,
  );

  let lastPrint = 0;
  const played = await runAll(todo, workers, (task, outcome, done) => {
    appendResult(file, { type: 'game', key: taskKey(task), outcome });
    const now = performance.now();
    if (now - lastPrint > 10_000 || done === todo.length) {
      lastPrint = now;
      process.stderr.write(`  ${done}/${todo.length} games, ${((now - started) / 1000).toFixed(0)} s\n`);
    }
  });

  console.log('');
  for (const line of report(configs, [...reused, ...played])) console.log(line);
  console.log(`\nTotal time: ${((performance.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
