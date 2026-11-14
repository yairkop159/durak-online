import { t } from '../i18n';
import type { TipId } from '../settings/settings';

/** A short first-game hint above the hand, dismissible. */
export function TipBanner({ tip, onDismiss }: { tip: TipId; onDismiss: () => void }) {
  return (
    <div
      role="note"
      data-testid="tip"
      className="flex w-full max-w-xl items-center gap-2 rounded-xl bg-accent/12 px-3 py-0.5 text-xs leading-snug sm:py-1.5 sm:text-[13px] ring-1 ring-accent/40"
    >
      <span aria-hidden="true">💡</span>
      <span className="sr-only">{t.tips.label}: </span>
      <span className="flex-1">{t.tips[tip]}</span>
      <button type="button" onClick={onDismiss} className="min-h-11 shrink-0 rounded-pill px-3 text-xs font-bold text-accent hover:bg-accent/15">
        {t.tips.dismiss}
      </button>
    </div>
  );
}
