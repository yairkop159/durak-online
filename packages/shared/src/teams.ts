import type { GameConfig, GameConfigInput } from './config.js';
import type { PlayerId } from './moves.js';
import type { GamePhase } from './view.js';

/**
 * 2v2 team mode (CLAUDE.md "Teams"). Teams follow seats: seat `i` plays for team `i % 2`, so
 * partners sit opposite (0+2 vs 1+3) and, with everyone in, the next seat clockwise is always an
 * opponent. Pure helpers shared by the engine, the server and the web.
 */
export const TEAM_GAME_PLAYERS = 4;
export const TEAMS = [0, 1] as const;
export type TeamIndex = (typeof TEAMS)[number];

export function isTeamGame(config: Pick<GameConfig, 'teams'> | GameConfigInput): boolean {
  return config.teams === true;
}

export function teamOfSeat(seat: number): TeamIndex {
  return seat % 2 === 0 ? 0 : 1;
}

/** The team of `playerId` in a seat-ordered list, or null if it isn't seated. */
export function teamOfPlayer(players: readonly { readonly id: PlayerId }[], playerId: PlayerId): TeamIndex | null {
  const seat = players.findIndex((p) => p.id === playerId);
  return seat < 0 ? null : teamOfSeat(seat);
}

/** The partner of `playerId` in a team game (the seat opposite), or null. */
export function partnerOf(
  config: Pick<GameConfig, 'teams'>,
  players: readonly { readonly id: PlayerId }[],
  playerId: PlayerId,
): PlayerId | null {
  if (!isTeamGame(config) || players.length !== TEAM_GAME_PLAYERS) return null;
  const seat = players.findIndex((p) => p.id === playerId);
  if (seat < 0) return null;
  return players[(seat + 2) % TEAM_GAME_PLAYERS]?.id ?? null;
}

/** Whether seats `a` and `b` play against each other (everyone else, outside team mode). */
export function seatsAreOpponents(config: Pick<GameConfig, 'teams'>, a: number, b: number): boolean {
  if (a === b) return false;
  return !isTeamGame(config) || teamOfSeat(a) !== teamOfSeat(b);
}

/**
 * The team that lost a finished team game: always the durak's team (a team loses only when one of
 * its players is the durak). Null outside team mode, before the end, and for a draw.
 */
export function losingTeam(game: {
  readonly config: Pick<GameConfig, 'teams'>;
  readonly players: readonly { readonly id: PlayerId }[];
  readonly phase: GamePhase;
}): TeamIndex | null {
  if (!isTeamGame(game.config) || game.phase.kind !== 'finished' || game.phase.durak === null) return null;
  return teamOfPlayer(game.players, game.phase.durak);
}
