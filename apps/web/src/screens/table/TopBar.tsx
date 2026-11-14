import type { PlayerView, RoomMember } from '@durak/shared';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { leaveOutcome } from '../../game/departure';
import { t } from '../../i18n';
import { useClient } from '../../net/react';
import { navigate } from '../../routing';

const ICON_BUTTON =
  'grid size-11 shrink-0 place-items-center rounded-full bg-surface/70 text-base ring-1 ring-line hover:bg-surface-2 aria-disabled:opacity-50';
const TEXT_BUTTON = 'min-h-11 shrink-0 whitespace-nowrap rounded-pill bg-surface/70 px-3 text-sm font-semibold ring-1 ring-line hover:bg-surface-2';

/** "Leave": straight out when nothing is at stake, otherwise after a confirm that says what happens to the seat. */
export function LeaveButton({ view, members }: { view: PlayerView; members: readonly RoomMember[] | undefined }) {
  const client = useClient();
  const [confirming, setConfirming] = useState(false);
  const outcome = leaveOutcome(view, members);

  const leave = () => {
    client.leaveRoom();
    navigate('/');
  };

  return (
    <>
      <button type="button" className={TEXT_BUTTON} onClick={() => (outcome === 'none' ? leave() : setConfirming(true))}>
        {t.table.leave}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t.table.leaveConfirm.title}
          body={outcome === 'takeover' ? t.table.leaveConfirm.takeover : t.table.leaveConfirm.resign}
          confirmLabel={t.table.leaveConfirm.confirm}
          danger
          onConfirm={() => {
            setConfirming(false);
            leave();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * The small bar above the table: leave (start side), and the room tools (end side). A short
 * landscape screen splits it: leave tops the seat column, the tools top the side panel.
 */
export function TopBar({
  view,
  members,
  extra,
}: {
  view: PlayerView;
  members: readonly RoomMember[] | undefined;
  /** More buttons for the end side (settings, help, new game). */
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2" data-testid="top-bar">
      <LeaveButton view={view} members={members} />
      <div className="flex shrink-0 items-center gap-1.5">{extra}</div>
    </div>
  );
}

export { ICON_BUTTON, TEXT_BUTTON };
