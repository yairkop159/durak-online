import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { navigate } from '../../routing';

/** A full page like /rules: a title, "back home", then the content (the document scrolls). */
export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-2xl font-black">{title}</h1>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="min-h-11 shrink-0 rounded-pill bg-surface/70 px-3 text-sm font-semibold ring-1 ring-line hover:bg-surface-2"
        >
          {t.common.backHome}
        </button>
      </header>
      {children}
    </div>
  );
}

/** An in-app link (History API) that is still a real <a> (open in new tab, long-press). */
export function AppLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      className={className}
    >
      {children}
    </a>
  );
}

export const linkButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-pill bg-surface/70 px-4 text-sm font-semibold text-accent ring-1 ring-line hover:bg-surface-2';
