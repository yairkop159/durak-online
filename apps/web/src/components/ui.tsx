import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';

type Variant = 'primary' | 'secondary' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-amber-400 text-slate-900 hover:bg-amber-300 disabled:bg-amber-400/40',
  secondary: 'bg-white/10 text-white hover:bg-white/20 border border-white/25',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`rounded-lg px-4 py-2 font-semibold transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-emerald-950/60 p-5 shadow-xl ring-1 ring-white/10 ${className}`}>{children}</div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'red' | 'blue' | 'amber' | 'gray' }) {
  const tones = {
    neutral: 'bg-white/15 text-white',
    red: 'bg-rose-600 text-white',
    blue: 'bg-sky-600 text-white',
    amber: 'bg-amber-400 text-slate-900',
    gray: 'bg-slate-500 text-white',
  } as const;
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
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
    <div role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-rose-700 px-4 py-3 text-center text-white shadow-2xl">
      {t.errors[lastError.code]}
    </div>
  );
}

export function ConnectionBanner() {
  const { connection } = useClientState();
  if (connection === 'connected') return null;
  return (
    <div role="status" className="bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-slate-900">
      {connection === 'connecting' ? t.connection.connecting : t.connection.disconnected}
    </div>
  );
}
