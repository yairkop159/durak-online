import { REACTION_IDS, type ReactionId } from '@durak/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n';
import { useClient } from '../net/react';

/**
 * "Quick reaction" button with a small 3x3 picker. The picker is the only interactive overlay and
 * exists only while it is open; Esc or a click outside closes it and focus returns to the button.
 * While the local mirror of the server's limit is empty the choices are disabled until it refills.
 */
export function ReactionButton({ disabled = false, placement = 'up' }: { disabled?: boolean; placement?: 'up' | 'down' }) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [, rerender] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const waitMs = open ? client.reactionReadyIn() : 0;

  // Re-enable the choices when the limit refills.
  useEffect(() => {
    if (!open || waitMs <= 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), waitMs + 20);
    return () => clearTimeout(timer);
  }, [open, waitMs]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const close = () => {
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const send = (id: ReactionId) => {
    if (client.react(id)) {
      setOpen(false);
      buttonRef.current?.focus();
    } else {
      rerender((n) => n + 1);
    }
  };

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-testid="reaction-button"
        disabled={disabled}
        aria-label={t.reactions.button}
        title={t.reactions.button}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-full bg-surface-2 text-lg ring-1 ring-line transition-colors hover:bg-white/10 disabled:opacity-40"
      >
        💬
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={t.reactions.pickerTitle}
          data-testid="reaction-picker"
          className={`absolute left-1/2 z-50 grid w-max -translate-x-1/2 grid-cols-3 gap-1 rounded-2xl bg-surface-2 p-1.5 shadow-xl ring-1 ring-line ${
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          {REACTION_IDS.map((id) => {
            const item = t.reactions.items[id];
            const emoji = item.text !== item.label;
            return (
              <button
                key={id}
                type="button"
                data-testid={`reaction-${id}`}
                disabled={waitMs > 0}
                aria-label={item.label}
                title={item.label}
                onClick={() => send(id)}
                className={`grid h-10 min-w-10 place-items-center rounded-xl px-1.5 font-bold transition-colors hover:bg-white/10 disabled:opacity-40 ${
                  emoji ? 'text-2xl' : 'text-xs'
                }`}
              >
                {item.text}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
