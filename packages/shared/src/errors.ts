export const GAME_ERROR_CODES = [
  'INVALID_PLAYER_COUNT',
  'DUPLICATE_PLAYER',
  'INVALID_CONFIG',
  'GAME_FINISHED',
  'UNKNOWN_PLAYER',
  'PLAYER_FINISHED',
  'NOT_YOUR_TURN',
  'CARD_NOT_IN_HAND',
  'INVALID_MOVE',
  'RANK_NOT_ON_TABLE',
  'TABLE_LIMIT_REACHED',
  'INVALID_ATTACK_INDEX',
  'ALREADY_COVERED',
  'CARD_DOES_NOT_BEAT',
  'TRANSFER_NOT_ALLOWED',
  'ALREADY_PASSED',
] as const;

export type GameErrorCode = (typeof GAME_ERROR_CODES)[number];

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
}
