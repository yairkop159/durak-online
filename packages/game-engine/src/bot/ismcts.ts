import type { ClientMove, Move, PlayerView } from '@durak/shared';
import { createRng, type Rng } from '../rng.js';
import { applyMove, getLegalMoves } from '../rules.js';
import type { GameState } from '../state.js';
import { getLegalMovesForView } from '../viewMoves.js';
import { sampleWorld } from './determinize.js';
import { pickGreedy } from './greedy.js';
import { initKnowledge, type PublicKnowledge } from './knowledge.js';
import { moveKey } from './moveKey.js';
import { cutoffRewards, terminalRewards } from './rewards.js';
import { canonicalActor } from './turnOrder.js';
import type { Bot } from './baselines.js';

/**
 * Search budget. `iterations` is fully deterministic; `deadlineMs` is an absolute time on the
 * injected clock `now` (the engine never reads a clock itself).
 */
export type BotBudget =
  | { readonly iterations: number }
  | { readonly deadlineMs: number; readonly now: () => number };

export interface BotOptions {
  /** Seed of the search's PRNG: the same view, knowledge, options and seed give the same move. */
  readonly seed: number;
  readonly budget: BotBudget;
  /** UCB1 exploration constant (rewards are in [0, 1]). Default 0.7. */
  readonly exploration?: number;
  /** Plies per rollout before the heuristic cutoff evaluation. Default 200. */
  readonly rolloutDepth?: number;
}

export const DEFAULT_EXPLORATION = 0.7;
export const DEFAULT_ROLLOUT_DEPTH = 200;

/** Diagnostics for tests and the benchmark. */
export interface SearchResult {
  readonly move: ClientMove | null;
  readonly iterations: number;
  /** Root children: move, visits, mean reward for the bot. */
  readonly root: readonly { readonly move: ClientMove; readonly visits: number; readonly mean: number }[];
}

interface Node {
  /** Seat that made the move leading into this node (-1 for the root). */
  readonly actor: number;
  readonly move: Move | null;
  /** `${actor}|${moveKey}` */
  readonly key: string;
  readonly children: Node[];
  visits: number;
  availability: number;
  /** Sum of the rewards of `actor` over the visits. */
  reward: number;
}

function newNode(actor: number, move: Move | null, key: string): Node {
  return { actor, move, key, children: [], visits: 0, availability: 0, reward: 0 };
}

/**
 * Chooses a move for the viewer of `view` with Single-Observer Information Set MCTS
 * (Cowling, Powley & Whitehouse 2012). Takes ONLY what a human player has: their sanitized view and
 * the public knowledge accumulated from earlier views. Hidden cards are sampled afresh every
 * iteration (`sampleWorld`); the real `GameState` is never an input.
 *
 * Returns null if the viewer has no legal move. A single legal move is returned without searching.
 */
export function chooseBotMove(view: PlayerView, knowledge: PublicKnowledge, options: BotOptions): ClientMove | null {
  return searchBotMove(view, knowledge, options).move;
}

/** `chooseBotMove` plus search diagnostics. */
export function searchBotMove(view: PlayerView, knowledge: PublicKnowledge, options: BotOptions): SearchResult {
  const legal = getLegalMovesForView(view);
  const me = view.viewerId;
  if (legal.length === 0 || me === null) return { move: null, iterations: 0, root: [] };
  if (legal.length === 1) return { move: legal[0]!, iterations: 0, root: [] };

  const rng = createRng(options.seed);
  const botSeat = view.players.findIndex((p) => p.id === me);
  const c = options.exploration ?? DEFAULT_EXPLORATION;
  const depth = options.rolloutDepth ?? DEFAULT_ROLLOUT_DEPTH;

  // Inconsistent knowledge (should not happen) falls back to what the view alone proves.
  let k = knowledge;
  if (!sampleWorld(view, k, createRng(options.seed ^ 0x5bd1e995)).ok) k = initKnowledge(view);
  if (!sampleWorld(view, k, createRng(options.seed ^ 0x5bd1e995)).ok) {
    return { move: pickGreedy(legal, { trumpSuit: view.trumpSuit, table: view.table }), iterations: 0, root: [] };
  }

  const root = newNode(-1, null, 'root');
  const budget = options.budget;
  let iterations = 0;
  for (;;) {
    if ('iterations' in budget) {
      if (iterations >= budget.iterations) break;
    } else if (iterations > 0 && budget.now() >= budget.deadlineMs) {
      break;
    }
    const world = sampleWorld(view, k, rng);
    if (!world.ok) break;
    iterate(root, world.value, botSeat, rng, c, depth);
    iterations++;
  }

  let best: Node | undefined;
  for (const child of root.children) {
    if (
      best === undefined ||
      child.visits > best.visits ||
      (child.visits === best.visits && child.reward / child.visits > best.reward / Math.max(1, best.visits))
    ) {
      best = child;
    }
  }
  const strip = (m: Move): ClientMove => toClientMove(m);
  return {
    move: best?.move ? strip(best.move) : pickGreedy(legal, { trumpSuit: view.trumpSuit, table: view.table }),
    iterations,
    root: root.children.map((n) => ({ move: strip(n.move!), visits: n.visits, mean: n.visits ? n.reward / n.visits : 0 })),
  };
}

function toClientMove(move: Move): ClientMove {
  const { playerId: _playerId, ...client } = move;
  return client as ClientMove;
}

/** One IS-MCTS iteration on the determinization `world`: select/expand, rollout, backpropagate. */
function iterate(root: Node, world: GameState, botSeat: number, rng: Rng, c: number, depth: number): void {
  const path: Node[] = [];
  let node = root;
  let state = world;
  let before = world;

  // Selection + expansion.
  for (;;) {
    if (state.phase.kind === 'finished') break;
    const actor = node === root ? botSeat : canonicalActor(state);
    if (actor < 0) break;
    const legal = getLegalMoves(state, state.players[actor]!.id);
    if (legal.length === 0) break;

    const childByKey = new Map<string, Node>();
    for (const child of node.children) childByKey.set(child.key, child);
    const available: Node[] = [];
    const untried: { move: Move; key: string }[] = [];
    for (const move of legal) {
      const key = `${actor}|${moveKey(move)}`;
      const child = childByKey.get(key);
      if (child) available.push(child);
      else untried.push({ move, key });
    }
    for (const child of available) child.availability++;

    let next: Node;
    if (untried.length > 0) {
      const pick = untried[rng.nextInt(untried.length)]!;
      next = newNode(actor, pick.move, pick.key);
      next.availability = 1;
      node.children.push(next);
    } else {
      next = available[0]!;
      let bestScore = -Infinity;
      for (const child of available) {
        const score = child.reward / child.visits + c * Math.sqrt(Math.log(child.availability) / child.visits);
        if (score > bestScore) {
          bestScore = score;
          next = child;
        }
      }
    }

    before = state;
    state = apply(state, next.move!);
    path.push(next);
    node = next;
    if (untried.length > 0) break; // expanded a new node: switch to the rollout
  }

  // Rollout with the greedy policy.
  let rewards: number[] | null = null;
  for (let ply = 0; ply < depth; ply++) {
    if (state.phase.kind === 'finished') break;
    const actor = canonicalActor(state);
    if (actor < 0) break;
    const move = pickGreedy(getLegalMoves(state, state.players[actor]!.id), {
      trumpSuit: state.trumpCard.suit,
      table: state.table,
    });
    if (!move) break;
    before = state;
    state = apply(state, move);
  }
  rewards = state.phase.kind === 'finished' ? terminalRewards(state, before) : cutoffRewards(state);

  // Backpropagation: each node accumulates the reward of the player who moved into it.
  for (const n of path) {
    n.visits++;
    n.reward += rewards[n.actor] ?? 0;
  }
}

function apply(state: GameState, move: Move): GameState {
  const result = applyMove(state, move);
  if (!result.ok) throw new Error(`Bot simulation produced an illegal move: ${result.error.code}`);
  return result.value;
}

/**
 * Wraps IS-MCTS as a `Bot`. `budget` is called once per decision, so a time budget can start its
 * deadline at the moment of the call (e.g. `() => ({ deadlineMs: clock() + 300, now: clock })`).
 * The search seed is drawn from the caller's `rng`.
 */
export function createIsmctsBot(config: {
  readonly budget: () => BotBudget;
  readonly exploration?: number;
  readonly rolloutDepth?: number;
}): Bot {
  return {
    name: 'ismcts',
    choose(view, knowledge, rng) {
      return chooseBotMove(view, knowledge, {
        seed: Math.floor(rng.next() * 0x1_0000_0000),
        budget: config.budget(),
        ...(config.exploration !== undefined ? { exploration: config.exploration } : {}),
        ...(config.rolloutDepth !== undefined ? { rolloutDepth: config.rolloutDepth } : {}),
      });
    },
  };
}
