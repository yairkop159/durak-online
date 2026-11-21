import type { DepartureKind } from '@durak/shared';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { t } from '../../i18n';

const ICON_BUTTON =
  'grid size-11 shrink-0 place-items-center rounded-full bg-surface/70 text-base ring-1 ring-line hover:bg-surface-2 aria-disabled:opacity-50';
const TEXT_BUTTON = 'min-h-11 shrink-0 whitespace-nowrap rounded-pill bg-surface/70 px-3 text-sm font-semibold ring-1 ring-line hover:bg-surface-2';

/**
 * "Leave": straight out when nothing is at stake, otherwise after a confirm that says what happens
 * to the seat. `extra` (a running tournament: what happens to the series) always asks first.
 */
export function LeaveButton({ outcome, onLeave, extra = null }: { outcome: DepartureKind; onLeave: () => void; extra?: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const leave = onLeave;
  const game = outcome === 'none' ? null : outcome === 'takeover' ? t.table.leaveConfirm.takeover : t.table.leaveConfirm.resign;
  const body = [game, extra].filter((line): line is string => line !== null).join(' ');

  return (
    <>
      <button
        type="button"
        className={TEXT_BUTTON}
        data-testid="leave-button"
        onClick={() => (outcome === 'none' && extra === null ? leave() : setConfirming(true))}
      >
        {t.table.leave}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t.table.leaveConfirm.title}
          body={body}
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
  leave,
  extra,
}: {
  /** The leave button (start side). */
  leave: ReactNode;
  /** More buttons for the end side (settings, help, new game). */
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2" data-testid="top-bar">
      {leave}
      <div className="flex shrink-0 items-center gap-1.5">{extra}</div>
    </div>
  );
}

export { ICON_BUTTON, TEXT_BUTTON };
