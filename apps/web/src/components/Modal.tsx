import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../i18n';
import { Button, Panel } from './ui';

/**
 * A centered dialog over a dimmed backdrop: focus moves into it on open (and back on close),
 * Escape and a backdrop click close it. Used by every confirm, settings, rules and vote dialog.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  closeLabel = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A wider panel (rules, settings). */
  wide?: boolean;
  /** Show the ✕ button in the header. */
  closeLabel?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, [tabindex]:not([tabindex="-1"])');
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg-0/70 p-safe-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[90dvh] w-full flex-col outline-none ${wide ? 'max-w-xl' : 'max-w-sm'}`}
      >
        <Panel className="flex min-h-0 flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            {closeLabel && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t.common.close}
                className="grid size-11 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-text"
              >
                ✕
              </button>
            )}
          </div>
          <div className="min-h-0 overflow-y-auto">{children}</div>
        </Panel>
      </div>
    </div>
  );
}

/** "Are you sure?" with a body text and confirm / cancel buttons. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} closeLabel={false}>
      <div className="flex flex-col gap-5">
        <p className="text-sm text-text/90" data-testid="confirm-body">
          {body}
        </p>
        <div className="flex gap-2">
          <Button variant={danger ? 'danger' : 'primary'} className="flex-1" onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" className="flex-1" onClick={onCancel} data-autofocus>
            {t.common.cancel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
