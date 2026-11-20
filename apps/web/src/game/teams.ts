import { isTeamGame, partnerOf, teamOfPlayer, type GameConfig, type PlayerId, type TeamIndex } from '@durak/shared';
import { t } from '../i18n';

/**
 * 2v2 team mode on the client (pure). Teams follow seats (0+2 vs 1+3), so everything here is
 * derived from the public view: the config flag and the seating order. Nothing is hidden.
 */
export interface TeamTable {
  readonly config: Pick<GameConfig, 'teams'>;
  readonly players: readonly { readonly id: PlayerId }[];
  readonly viewerId: PlayerId | null;
}

/** The team of `playerId`, or null outside team mode. */
export function teamOf(table: TeamTable, playerId: PlayerId): TeamIndex | null {
  return isTeamGame(table.config) ? teamOfPlayer(table.players, playerId) : null;
}

/** The viewer's partner (the seat opposite), or null (no team game, or a spectator). */
export function myPartner(table: TeamTable): PlayerId | null {
  return table.viewerId === null ? null : partnerOf(table.config, table.players, table.viewerId);
}

/** The team's display name ("הקבוצה הכחולה" / "הקבוצה הכתומה"). */
export function teamName(team: TeamIndex): string {
  return t.teams.names[team];
}

export type ViewerResult = 'won' | 'lost' | null;

/**
 * The seated viewer's result when the game ended with `durak` (null = a draw): lost if they are the
 * durak or, in team mode, on the durak's team. Null for spectators and draws.
 */
export function viewerResult(table: TeamTable, durak: PlayerId | null): ViewerResult {
  const me = table.viewerId;
  if (me === null || durak === null || !table.players.some((p) => p.id === me)) return null;
  if (durak === me) return 'lost';
  const mine = teamOf(table, me);
  return mine !== null && mine === teamOf(table, durak) ? 'lost' : 'won';
}

/** Tailwind classes for a team's colour (literal strings, so Tailwind generates them). */
export const TEAM_RING = ['ring-team-a/80', 'ring-team-b/80'] as const;
export const TEAM_DOT = ['bg-team-a', 'bg-team-b'] as const;
export const TEAM_TEXT = ['text-team-a', 'text-team-b'] as const;
