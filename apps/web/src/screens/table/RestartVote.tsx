import type { PlayerView, RoomStatePayload } from '@durak/shared';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { Button } from '../../components/ui';
import { nicknameOf } from '../../game/seats';
import { t } from '../../i18n';
import { secondsLeft, useCountdown } from '../../net/clock';
import { useClient, useClientState } from '../../net/react';
import { TEXT_BUTTON } from './TopBar';

/** Whether the viewer may propose a new game: a seated human (not left) while the game runs. */
export function canProposeRestart(view: PlayerView, room: RoomStatePayload | null): boolean {
  if (view.viewerId === null || view.phase.kind === 'finished' || room?.status !== 'playing') return false;
  const me = room.members.find((m) => m.playerId === view.viewerId);
  return !!me && !me.isBot && !me.leftGame;
}

/** Top-bar "new game" button with its confirm dialog. Disabled while a vote is open. */
export function RestartButton({ disabled }: { disabled: boolean }) {
  const client = useClient();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        className={TEXT_BUTTON}
        aria-disabled={disabled}
        onClick={() => !disabled && setConfirming(true)}
      >
        {t.restart.button}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t.restart.confirmTitle}
          body={t.restart.confirmBody}
          confirmLabel={t.restart.propose}
          onConfirm={() => {
            setConfirming(false);
            client.proposeRestart();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * The open vote: awaited voters get the question with accept / decline and a countdown;
 * everyone else sees how many answers are still missing.
 */
export function RestartVotePanel({ viewerId }: { viewerId: string | null }) {
  const client = useClient();
  const { room, roomReceivedAt } = useClientState();
  const vote = room?.restartVote ?? null;
  const remaining = useCountdown(
    vote ? { turnDeadline: vote.expiresAt, serverTime: vote.serverTime, receivedAt: roomReceivedAt } : null,
    client.now,
  );
  if (!vote || !room) return null;
  const proposer = nicknameOf(vote.proposerId, room.members);
  const asked = viewerId !== null && vote.awaiting.includes(viewerId);
  const seconds = remaining === null ? null : secondsLeft(remaining);
  const total = vote.accepted.length + vote.awaiting.length;

  return (
    <div
      role={asked ? 'alertdialog' : 'status'}
      aria-label={t.restart.title}
      data-testid="restart-vote"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl bg-surface-2/95 px-3 py-2 text-sm ring-1 ring-accent/40"
    >
      <span className="font-semibold">
        {viewerId === vote.proposerId ? t.restart.youProposed : t.restart.proposed(proposer)}
      </span>
      {seconds !== null && <span className="tabular-nums text-muted">⏱ {seconds}</span>}
      {asked ? (
        <span className="flex gap-2">
          <Button className="min-h-11" onClick={() => client.respondRestart(vote.voteId, true)}>
            {t.restart.accept}
          </Button>
          <Button variant="secondary" className="min-h-11" onClick={() => client.respondRestart(vote.voteId, false)}>
            {t.restart.decline}
          </Button>
        </span>
      ) : (
        <span className="text-muted">{t.restart.waiting(vote.accepted.length, total)}</span>
      )}
    </div>
  );
}
