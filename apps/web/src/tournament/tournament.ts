import { TOURNAMENT_MIN_HUMANS, type EntrantKey, type RoomMember, type RoomStatePayload, type StandingRow, type TournamentView } from '@durak/shared';

/**
 * Pure helpers for the tournament UI (CLAUDE.md "Tournaments"). The server decides everything;
 * these only explain room:state.tournament to the viewer.
 */

/** The series shown with the table: the room's, while running or once over (until the lobby). */
export function roomTournament(room: RoomStatePayload | null | undefined): TournamentView | null {
  return room?.tournament ?? null;
}

/** "2.5", "3": points are multiples of 0.5. */
export function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/** Games still to play (the running one included while a game runs). */
export function gamesLeft(t: TournamentView): number {
  return Math.max(0, t.gamesPlanned - t.gamesPlayed);
}

/** The number of the game being played now (1-based), capped at the planned count. */
export function currentGameNumber(t: TournamentView): number {
  return Math.min(t.gamesPlanned, t.gamesPlayed + 1);
}

/** Rows sharing first place (the leaders), before a champion is known. */
export function leaders(t: TournamentView): StandingRow[] {
  if (t.gamesPlayed === 0) return [];
  return t.standings.filter((r) => r.rank === 1);
}

export function rowOf(t: TournamentView, key: EntrantKey): StandingRow | undefined {
  return t.standings.find((r) => r.key === key);
}

/** A champion row made of a bot seat (a bot won the series). */
export function isBotRow(t: TournamentView, row: StandingRow): boolean {
  return row.playerIds.some((id) => t.roster.find((s) => s.playerId === id)?.isBot === true);
}

/** Whether the viewer is behind this row (their seat, or their team). */
export function isMine(row: StandingRow, viewerId: string | null): boolean {
  return viewerId !== null && row.playerIds.includes(viewerId);
}

/**
 * Between games of a running series, whether the viewer may start the next game or end it now:
 * the host always; any connected human who holds their seat once the host is away
 * (`leadOpenAt` reached, compared on the server's clock: `serverNow`). Mirrors the server's
 * `canLeadTournament`; the server still checks.
 */
export function canLead(
  room: RoomStatePayload,
  viewerId: string | null,
  serverNow: number,
): boolean {
  const t = room.tournament;
  if (!t || t.status !== 'running' || room.status !== 'finished' || viewerId === null) return false;
  const me = room.members.find((m) => m.playerId === viewerId);
  if (!me || me.isBot || me.leftGame) return false;
  if (room.hostId === viewerId) return true;
  return me.connected && t.leadOpenAt !== null && serverNow >= t.leadOpenAt;
}

/** What leaving the room now does to the viewer's series (null = no running series / not seated). */
export type TournamentLeave = 'bot' | 'ends';

export function tournamentLeave(room: RoomStatePayload | null, viewerId: string | null): TournamentLeave | null {
  const t = room?.tournament;
  if (!t || t.status !== 'running' || viewerId === null) return null;
  const mySeat = t.roster.find((s) => s.playerId === viewerId);
  if (!mySeat || mySeat.isBot || mySeat.left) return null;
  const othersIn = t.roster.filter((s) => s.playerId !== viewerId && !s.isBot && !s.left && stillSeated(room!.members, s.playerId));
  // The series needs TOURNAMENT_MIN_HUMANS humans; without me, the others are what is left.
  return othersIn.length < TOURNAMENT_MIN_HUMANS ? 'ends' : 'bot';
}

function stillSeated(members: readonly RoomMember[], playerId: string): boolean {
  const m = members.find((x) => x.playerId === playerId);
  return !!m && !m.leftGame;
}
