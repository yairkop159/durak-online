import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { nicknameOf } from '../game/seats';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';
import { isReconnecting } from '../net/store';

type Variant = 'primary' | 'secondary' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink enabled:not-aria-disabled:hover:bg-accent-strong',
  secondary: 'bg-surface-2 text-text ring-1 ring-line-strong enabled:not-aria-disabled:hover:bg-surface-3',
  danger: 'bg-take text-white enabled:not-aria-disabled:hover:brightness-110',
};

/**
 * One disabled look for every variant. Applies to `disabled` and to `aria-disabled="true"`
 * (a button that stays clickable, e.g. to explain why it can't act yet).
 */
export const DISABLED_BUTTON_CLASSES =
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted disabled:ring-1 disabled:ring-line disabled:shadow-none disabled:filter-none disabled:opacity-55 ' +
  'aria-disabled:cursor-not-allowed aria-disabled:bg-surface-2 aria-disabled:text-muted aria-disabled:ring-1 aria-disabled:ring-line aria-disabled:shadow-none aria-disabled:filter-none aria-disabled:opacity-55 aria-disabled:active:translate-y-0';

/** Real, clickable actions: solid fill, rounded, shadow — never confused with a Pill. */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'lg' }) {
  const sizing = size === 'lg' ? 'min-h-12 px-7 text-lg' : 'min-h-11 px-4';
  return (
    <button
      type="button"
      className={`rounded-btn font-bold shadow-btn transition-[background-color,filter,translate] duration-(--dur-hover) active:translate-y-px ${sizing} ${VARIANT[variant]} ${DISABLED_BUTTON_CLASSES} ${className}`}
      {...props}
    />
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[22px] bg-surface/90 p-5 shadow-panel ring-1 ring-line backdrop-blur ${className}`}>{children}</div>;
}

export type PillTone = 'neutral' | 'attack' | 'defend' | 'accent' | 'warn' | 'muted';

const PILL: Record<PillTone, string> = {
  neutral: 'bg-white/8 text-text/85 ring-line',
  attack: 'bg-role-attack/12 text-role-attack ring-role-attack/30',
  defend: 'bg-role-defend/12 text-role-defend ring-role-defend/30',
  accent: 'bg-accent/12 text-accent ring-accent/30',
  warn: 'bg-warn/12 text-warn ring-warn/30',
  muted: 'bg-white/5 text-muted ring-line',
};

/** Status label (role, AFK, offline…). A plain span: not focusable, no hover, no pointer. */
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span
      className={`pointer-events-none inline-flex items-center gap-1 rounded-pill px-2 py-px text-[10px] leading-4 font-semibold whitespace-nowrap ring-1 select-none ${PILL[tone]}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  );
}

const AVATAR_HUES = [172, 262, 199, 330, 38, 145];

function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

/**
 * Initial in a circle, with an optional countdown ring (`progress` 1 -> 0) around it:
 * turquoise, amber under 50%, red under 20%, pulsing in the last seconds.
 */
export function Avatar({
  id,
  name,
  size = 40,
  progress,
  urgent = false,
  dim = false,
}: {
  id: string;
  name: string;
  size?: number;
  progress?: number | null;
  urgent?: boolean;
  dim?: boolean;
}) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  const hue = hueOf(id);
  const ring = size + 8;
  const r = ring / 2 - 2;
  const length = 2 * Math.PI * r;
  const p = progress ?? null;
  const color = p === null ? '' : p < 0.2 ? 'var(--color-danger)' : p < 0.5 ? 'var(--color-warn)' : 'var(--color-accent)';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: ring, height: ring }}>
      <span
        aria-hidden="true"
        className={`flex items-center justify-center rounded-full font-black ${dim ? 'opacity-50' : ''}`}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.42,
          color: `hsl(${hue} 90% 88%)`,
          background: `radial-gradient(circle at 30% 25%, hsl(${hue} 55% 42%), hsl(${hue} 60% 22%))`,
          boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.12)',
        }}
      >
        {initial}
      </span>
      {p !== null && (
        <svg
          aria-hidden="true"
          data-testid={`ring-${id}`}
          className={`absolute inset-0 -rotate-90 ${urgent ? 'animate-pulse-ring' : ''}`}
          width={ring}
          height={ring}
        >
          <circle cx={ring / 2} cy={ring / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth={3} />
          <circle
            cx={ring / 2}
            cy={ring / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length * (1 - Math.max(0, Math.min(1, p)))}
            style={{ transition: 'stroke-dashoffset 250ms linear, stroke 300ms', filter: `drop-shadow(0 0 4px ${color})` }}
          />
        </svg>
      )}
    </span>
  );
}

/** Shows the last server error in Hebrew for a few seconds. */
export function ErrorToast() {
  const client = useClient();
  const { lastError } = useClientState();
  useEffect(() => {
    if (!lastError) return;
    const timer = setTimeout(() => client.dismissError(), 4000);
    return () => clearTimeout(timer);
  }, [client, lastError]);
  if (!lastError) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-md rounded-btn bg-surface-2 px-4 py-3 text-center text-text shadow-panel ring-1 ring-danger/60"
    >
      {t.errors[lastError.code]}
    </div>
  );
}

/** A short, non-error message for everyone in the room (how a restart vote ended). */
export function NoticeToast() {
  const client = useClient();
  const { notice, room } = useClientState();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => client.dismissNotice(), 4000);
    return () => clearTimeout(timer);
  }, [client, notice]);
  if (!notice) return null;
  const { outcome, by } = notice.payload;
  const text =
    outcome === 'passed'
      ? t.restart.passed
      : outcome === 'declined'
        ? t.restart.declined(nicknameOf(by ?? '', room?.members))
        : outcome === 'expired'
          ? t.restart.expired
          : t.restart.cancelled;
  return (
    <div
      role="status"
      data-testid="notice"
      className="fixed inset-x-4 top-[calc(3.5rem+env(safe-area-inset-top))] z-50 mx-auto max-w-md rounded-btn bg-surface-2 px-4 py-3 text-center text-text shadow-panel ring-1 ring-accent/50"
    >
      {text}
    </div>
  );
}

export function ConnectionBanner() {
  const state = useClientState();
  const reconnecting = isReconnecting(state);
  if (state.connection === 'connected' && !reconnecting) return null;
  const text = reconnecting
    ? t.connection.reconnecting
    : state.connection === 'connecting'
      ? t.connection.connecting
      : t.connection.disconnected;
  return (
    <div role="status" aria-live="polite" className="sticky top-0 z-50 bg-warn/90 px-4 py-1.5 text-center text-sm font-semibold text-bg-0">
      {text}
    </div>
  );
}

/** Text input styled for the dark theme. */
export const inputClass =
  'rounded-btn bg-bg-0/70 px-3 py-2.5 text-text placeholder:text-muted/70 ring-1 ring-line-strong outline-none focus:ring-2 focus:ring-accent';
