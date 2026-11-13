import { t } from '../i18n';
import type { TipId } from '../settings/settings';

/** A short first-game hint above the hand, dismissible. */
export function TipBanner({ tip, onDismiss }: { tip: TipId; onDismiss: () => void }) {
  return (
    <div
      role="note"
      data-testid="tip"
      className="flex w-full max-w-md items-center gap-2 rounded-xl bg-accent/12 px-3 py-2 text-sm ring-1 ring-accent/40"
    >
      <span aria-hidden="true">💡</span>
      <span className="sr-only">{t.tips.label}: </span>
      <span className="flex-1">{t.tips[tip]}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 rounded-pill px-2 py-1 text-xs font-bold text-accent hover:bg-accent/15">
        {t.tips.dismiss}
      </button>
    </div>
  );
}
