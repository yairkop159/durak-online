import { t } from '../i18n';

/** The 2v2 switch (Home, and the host's lobby in 4-seat rooms). A real switch: role, checked state, 44 px tall. */
export function TeamsSwitch({ checked, onChange, label = t.teams.toggle, hint = t.teams.toggleHint, testId = 'teams-switch' }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label?: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`flex min-h-11 w-full items-center gap-3 rounded-btn px-3 py-2 text-start ring-1 transition-colors ${
        checked ? 'bg-accent/8 ring-accent' : 'bg-surface-2/50 ring-line hover:bg-surface-2'
      }`}
    >
      <span
        aria-hidden="true"
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3'}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-[inset-inline-start] ${checked ? 'start-[1.125rem]' : 'start-0.5'}`} />
      </span>
      <span className="flex flex-col">
        <span className="font-semibold">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}
