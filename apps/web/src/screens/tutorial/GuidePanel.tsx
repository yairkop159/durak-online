import { useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import type { Rich } from '../../tutorial/rich';
import type { TutorialPhase } from '../../tutorial/machine';
import { TutorialText } from './TutorialText';

export interface GuideAction {
  readonly label: string;
  readonly run: () => void;
}

/**
 * The lesson's goal, hint and feedback, above the hand (beside the table on a phone on its side).
 * Its text is a polite live region: every new goal or explanation is announced.
 */
export function GuidePanel({
  heading,
  phase,
  goal,
  hint,
  feedback,
  progressNote,
  primary,
  secondary,
  onSkip,
  compact = false,
}: {
  /** "שיעור 3 מתוך 10 · הגנה". */
  heading: string;
  phase: TutorialPhase;
  goal: Rich;
  hint: Rich;
  /** The explanation (wrong / failed) or the success text. */
  feedback: Rich | null;
  /** e.g. "נבחרו 1 מתוך 2". */
  progressNote?: string | null;
  /** "נסו שוב" / "לשיעור הבא"; none while playing. */
  primary?: GuideAction | null;
  secondary?: GuideAction | null;
  onSkip?: (() => void) | null;
  compact?: boolean;
}) {
  const [hintFor, setHintFor] = useState<string | null>(null);
  // The hint opens on request, and by itself after a wrong try.
  const hintOpen = hintFor === heading || phase === 'wrong';
  const title =
    phase === 'wrong' ? t.tutorial.wrongTitle : phase === 'success' ? t.tutorial.successTitle : phase === 'failed' ? t.tutorial.failedTitle : t.tutorial.goal;
  const tone =
    phase === 'success' ? 'ring-accent bg-accent/10' : phase === 'wrong' || phase === 'failed' ? 'ring-warn bg-warn/10' : 'ring-accent/45 bg-surface-2/95';
  return (
    <section
      className={`relative z-10 flex w-full max-w-xl shrink-0 flex-col gap-1.5 rounded-xl px-3 py-2 text-sm shadow-panel ring-1 ${tone}`}
      aria-label={heading}
      data-testid="guide"
      data-phase={phase}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted">{heading}</span>
        {onSkip && phase !== 'success' && (
          <button
            type="button"
            onClick={onSkip}
            className="min-h-11 shrink-0 rounded-pill px-3 text-xs font-semibold text-muted ring-1 ring-line hover:bg-surface-3"
          >
            {t.tutorial.skip}
          </button>
        )}
      </div>
      <div className={`overflow-y-auto leading-snug ${compact ? 'max-h-[38dvh]' : 'max-h-[22dvh]'}`} aria-live="polite" data-testid="guide-text">
        <p>
          <strong className={phase === 'success' ? 'text-accent' : phase === 'playing' || phase === 'opponent' ? '' : 'text-warn'}>{title}: </strong>
          <TutorialText text={feedback ?? goal} />
          {progressNote && <span className="text-muted"> ({progressNote})</span>}
        </p>
        {hintOpen && (phase === 'playing' || phase === 'wrong') && (
          <p className="mt-1 text-muted" data-testid="guide-hint">
            💡 <TutorialText text={hint} />
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {phase === 'playing' && !hintOpen && (
          <button
            type="button"
            onClick={() => setHintFor(heading)}
            className="min-h-11 rounded-pill px-3 text-sm font-semibold ring-1 ring-line-strong hover:bg-surface-3"
          >
            💡 {t.tutorial.hint}
          </button>
        )}
        {secondary && (
          <Button variant="secondary" onClick={secondary.run}>
            {secondary.label}
          </Button>
        )}
        {primary && <Button onClick={primary.run}>{primary.label}</Button>}
      </div>
    </section>
  );
}
