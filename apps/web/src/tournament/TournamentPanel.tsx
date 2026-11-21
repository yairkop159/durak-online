import type { EntrantKey, RoomStatePayload, StandingRow, TeamIndex, TournamentView } from '@durak/shared';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../components/Modal';
import { Button, Pill } from '../components/ui';
import { TEAM_DOT, TEAM_TEXT, teamName } from '../game/teams';
import { t } from '../i18n';
import { secondsLeft, useCountdown } from '../net/clock';
import { canLead, currentGameNumber, formatPoints, gamesLeft, isBotRow, isMine, leaders } from './tournament';

const teamIndexOf = (key: EntrantKey): TeamIndex => (key === 'team1' ? 1 : 0);

/** A row's display name: the player, or the team (with both partners under it). */
function rowName(t_: TournamentView, row: StandingRow, nameOf: (id: string) => string): string {
  return t_.teams ? teamName(teamIndexOf(row.key)) : nameOf(row.key);
}

/** The headline of a series that is over (champions, a bot win, or an early end). */
export function championLine(tv: TournamentView, nameOf: (id: string) => string, viewerId: string | null): string {
  if (tv.status === 'endedEarly' || tv.champions.length === 0) return t.tournament.endedEarly;
  const rows = tv.standings.filter((r) => tv.champions.includes(r.key));
  if (rows.length > 1) return t.tournament.coChampions(rows.map((r) => rowName(tv, r, nameOf)).join(', '));
  const row = rows[0]!;
  if (tv.teams) return t.tournament.teamChampion(teamName(teamIndexOf(row.key)));
  if (isMine(row, viewerId)) return t.tournament.youChampion;
  if (isBotRow(tv, row)) return t.tournament.botChampion(nameOf(row.key));
  return t.tournament.champion(nameOf(row.key));
}

/** The standings table (spectator-safe: only public data). */
export function TournamentStandings({
  tournament: tv,
  nameOf,
  viewerId,
}: {
  tournament: TournamentView;
  nameOf: (id: string) => string;
  viewerId: string | null;
}) {
  const over = tv.status !== 'running';
  return (
    <table className="w-full border-separate border-spacing-y-1 text-sm" data-testid="tournament-standings">
      <caption className="sr-only">{over ? t.tournament.finalStandings : t.tournament.standings}</caption>
      <thead>
        <tr className="text-xs text-muted">
          <th scope="col" className="w-7 px-1 text-center font-medium">{t.tournament.columns.rank}</th>
          <th scope="col" className="px-1 text-start font-medium">{t.tournament.columns.name}</th>
          <th scope="col" className="px-1 text-center font-medium">{t.tournament.columns.points}</th>
          <th scope="col" className="px-1 text-center font-medium">{t.tournament.columns.last}</th>
          <th scope="col" className="px-1 text-center font-medium">{t.tournament.columns.duraks}</th>
        </tr>
      </thead>
      <tbody>
        {tv.standings.map((row) => {
          const mine = isMine(row, viewerId);
          const champion = tv.champions.includes(row.key);
          const left = !row.eligible;
          const team = tv.teams ? teamIndexOf(row.key) : null;
          return (
            <tr
              key={row.key}
              data-testid={`standing-${row.key}`}
              data-rank={row.rank}
              className={`${champion ? 'bg-accent/15' : mine ? 'bg-select/12' : 'bg-white/5'} ${left ? 'opacity-70' : ''}`}
            >
              <td className="rounded-s-lg px-1 py-1.5 text-center font-black tabular-nums text-accent">
                {champion ? '🏆' : row.rank}
              </td>
              <td className="max-w-0 px-1 py-1.5">
                <div className="flex items-center gap-1.5">
                  {team !== null && <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${TEAM_DOT[team]}`} />}
                  <span className={`truncate font-semibold ${team !== null ? TEAM_TEXT[team] : ''}`}>{rowName(tv, row, nameOf)}</span>
                  {mine && <span className="shrink-0 text-xs text-muted">({t.tournament.you})</span>}
                  {left && !tv.teams && <Pill tone="muted">{t.tournament.left}</Pill>}
                </div>
                {tv.teams && (
                  <div className="truncate text-xs text-muted">{row.playerIds.map(nameOf).join(' · ')}</div>
                )}
              </td>
              <td className="px-1 py-1.5 text-center text-base font-black tabular-nums" dir="ltr">{formatPoints(row.points)}</td>
              <td className="px-1 py-1.5 text-center tabular-nums text-muted" dir="ltr">
                {row.lastPoints === null ? '–' : `+${formatPoints(row.lastPoints)}`}
              </td>
              <td className="rounded-e-lg px-1 py-1.5 text-center tabular-nums" dir="ltr">{row.duraks}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Title, progress (or the champion), the leader, and the table. */
export function TournamentSummary({
  tournament: tv,
  nameOf,
  viewerId,
}: {
  tournament: TournamentView;
  nameOf: (id: string) => string;
  viewerId: string | null;
}) {
  const over = tv.status !== 'running';
  const top = leaders(tv);
  return (
    <section className="flex w-full flex-col gap-1.5" aria-labelledby="tournament-title" data-testid="tournament-summary">
      <h3 id="tournament-title" className="flex items-center justify-center gap-1.5 text-base font-bold">
        <span aria-hidden="true">🏆</span>
        {over ? t.tournament.finalStandings : t.tournament.standings}
      </h3>
      {over ? (
        <p className={`text-sm font-bold ${tv.status === 'endedEarly' ? 'text-warn' : 'text-accent'}`} data-testid="tournament-result">
          {championLine(tv, nameOf, viewerId)}
        </p>
      ) : (
        <p className="text-xs text-muted" data-testid="tournament-progress">
          {t.tournament.afterGame(tv.gamesPlayed, tv.gamesPlanned)} · {t.tournament.gamesLeft(gamesLeft(tv))}
        </p>
      )}
      {!over && top.length > 0 && (
        <p className="text-sm font-semibold" data-testid="tournament-leader">
          {top.length === 1
            ? t.tournament.leader(rowName(tv, top[0]!, nameOf))
            : t.tournament.leadersTied(top.map((r) => rowName(tv, r, nameOf)).join(', '))}
        </p>
      )}
      {tv.status === 'endedEarly' && <p className="text-xs text-muted">{t.tournament.endedEarlyBody}</p>}
      <TournamentStandings tournament={tv} nameOf={nameOf} viewerId={viewerId} />
    </section>
  );
}

/**
 * Between games of a running series: "next game" and "end" for whoever may lead (the host, or
 * anyone once the host has been away long enough), a waiting line for everyone else.
 */
export function TournamentActions({
  room,
  viewerId,
  roomReceivedAt,
  now,
  nameOf,
  onNext,
  onEnd,
  leave,
}: {
  room: RoomStatePayload;
  viewerId: string | null;
  /** Local time the room:state arrived (the countdown's base, like the restart vote). */
  roomReceivedAt: number;
  now: () => number;
  nameOf: (id: string) => string;
  onNext: () => void;
  onEnd: () => void;
  /** The leave button (players only). */
  leave?: ReactNode;
}) {
  const tv = room.tournament!;
  const [confirming, setConfirming] = useState(false);
  const remaining = useCountdown(
    tv.leadOpenAt !== null ? { turnDeadline: tv.leadOpenAt, serverTime: tv.serverTime, receivedAt: roomReceivedAt } : null,
    now,
  );
  const serverNow = tv.leadOpenAt !== null && remaining !== null ? tv.leadOpenAt - remaining : tv.serverTime;
  const lead = canLead(room, viewerId, serverNow);
  const host = room.members.find((m) => m.playerId === room.hostId);
  const next = currentGameNumber(tv);

  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="tournament-actions">
      {lead ? (
        <>
          <Button size="lg" className="w-full" onClick={onNext} data-testid="tournament-next">
            {t.tournament.next(next, tv.gamesPlanned)}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)} data-testid="tournament-end">
            {t.tournament.end}
          </Button>
        </>
      ) : (
        <p className="text-center text-sm text-muted" role="status" data-testid="tournament-waiting">
          {host ? t.tournament.waitingForHost(nameOf(host.playerId)) : null}
          {tv.leadOpenAt !== null && remaining !== null && remaining > 0 && (
            <span className="block text-xs">{t.tournament.hostAwayIn(secondsLeft(remaining))}</span>
          )}
        </p>
      )}
      {lead && room.hostId !== viewerId && <p className="text-center text-xs text-muted">{t.tournament.hostAway}</p>}
      {leave}
      {confirming && (
        <ConfirmDialog
          title={t.tournament.endConfirm.title}
          body={t.tournament.endConfirm.body}
          confirmLabel={t.tournament.endConfirm.confirm}
          danger
          onConfirm={() => {
            setConfirming(false);
            onEnd();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** The top-bar pill while a series game runs: "🏆 2/5". */
export function TournamentPill({ tournament: tv }: { tournament: TournamentView }) {
  const k = currentGameNumber(tv);
  const label = t.tournament.gamePill(k, tv.gamesPlanned);
  return (
    <span
      className="grid min-h-11 shrink-0 place-items-center rounded-pill bg-surface/70 px-2.5 text-sm font-bold ring-1 ring-accent/50"
      aria-label={label}
      title={label}
      data-testid="tournament-pill"
    >
      <span aria-hidden="true" dir="ltr">🏆 {k}/{tv.gamesPlanned}</span>
    </span>
  );
}
