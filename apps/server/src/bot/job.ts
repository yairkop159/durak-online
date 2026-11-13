import type { PublicKnowledge } from '@durak/game-engine';
import type { BotDifficulty, ClientMove, PlayerView } from '@durak/shared';

/**
 * How a bot decides. `thinkMs` is a relative budget: the thread that runs the search starts its own
 * clock (the engine never reads one), so the job stays plain JSON.
 */
export type BotJobPolicy =
  | { readonly kind: 'greedy'; readonly randomRate: number }
  | { readonly kind: 'ismcts'; readonly budget: { readonly iterations: number } }
  | { readonly kind: 'ismcts'; readonly budget: { readonly thinkMs: number } };

/**
 * The ONLY thing a bot decision receives (and the only thing that crosses the worker boundary):
 * the seat's sanitized view, that seat's public knowledge at the same version, and options.
 * Never a GameState — see CLAUDE.md "No-cheating rule".
 */
export interface BotJob {
  readonly jobId: number;
  /** sanitizeStateForPlayer(state, seat) */
  readonly view: PlayerView;
  readonly knowledge: PublicKnowledge;
  readonly options: { readonly seed: number; readonly policy: BotJobPolicy };
}

export interface BotJobResult {
  readonly jobId: number;
  readonly move: ClientMove | null;
  /** Set when the decision threw; the caller falls back to GreedyBot. */
  readonly failed?: true;
}

/** Runs bot decisions. `signal` aborts a job that is no longer wanted (its result is then ignored). */
export interface BotRunner {
  run(job: BotJob, signal: AbortSignal): Promise<ClientMove | null>;
  dispose(): Promise<void>;
}

export type BotPolicies = Readonly<Record<BotDifficulty, BotJobPolicy>>;

export const DEFAULT_BOT_POLICIES: BotPolicies = {
  easy: { kind: 'greedy', randomRate: 0.15 },
  medium: { kind: 'ismcts', budget: { iterations: 200 } },
  hard: { kind: 'ismcts', budget: { thinkMs: 300 } },
};

/** Strength used when a bot plays for an AFK human. */
export const AFK_TAKEOVER_DIFFICULTY: BotDifficulty = 'medium';
