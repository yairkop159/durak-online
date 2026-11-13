import { BOT_DIFFICULTIES, type BotDifficulty } from '@durak/shared';
import { t } from '../i18n';

/** Segmented easy / medium / hard control. */
export function DifficultyPicker({ value, onChange }: { value: BotDifficulty; onChange: (d: BotDifficulty) => void }) {
  return (
    <div role="radiogroup" aria-label={t.bots.difficulty} className="grid grid-cols-3 gap-1.5">
      {BOT_DIFFICULTIES.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          onClick={() => onChange(d)}
          className={`rounded-btn py-1.5 text-sm font-bold ring-1 transition-colors ${
            value === d ? 'bg-accent text-accent-ink ring-accent' : 'bg-surface-2 ring-line hover:bg-surface-3'
          }`}
        >
          {t.bots.difficulties[d]}
        </button>
      ))}
    </div>
  );
}
