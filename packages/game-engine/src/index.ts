export type { GameState, PlayerState } from './state.js';
export { ok, err, gameError, type Result } from './result.js';
export { createRng, shuffle, type Rng } from './rng.js';
export { createDeck, beats, hasCard, removeCard } from './deck.js';
export { createGame, createGameWithDeck, chooseFirstAttacker, type CreateGameOptions } from './setup.js';
export {
  applyMove,
  validateMove,
  getLegalMoves,
  getPlayersToAct,
  canThrowIn,
  boutCardLimit,
  drawOrder,
  nextActiveIndex,
  playerIndex,
  isFinished,
} from './rules.js';
export { sanitizeStateForPlayer } from './sanitize.js';
export { getLegalMovesForView } from './viewMoves.js';
export {
  getTimeoutMoves,
  getAwaitedPlayers,
  applyTimeout,
  resign,
  abandon,
  timeoutOpeningCard,
  type TimeoutResult,
} from './timeout.js';
export {
  tableCards,
  withoutCards,
  includesCard,
  leftViewerHand,
  viewHandCounts,
  viewDrawOrder,
  simulateViewDraws,
  isBoutResolutionStep,
  inferBoutResolution,
  type BoutResolution,
  type DrawScenario,
} from './viewInference.js';
export * from './bot/index.js';
// Server-side turn order (needs the full state), so it is exported here, not from the view-only bot barrel.
export { canonicalActor } from './bot/turnOrder.js';
