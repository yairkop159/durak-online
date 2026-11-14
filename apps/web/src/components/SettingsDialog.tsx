import { useId, useState } from 'react';
import { t } from '../i18n';
import { useSettings, useSettingsStore, useVibrator } from '../settings/react';
import type { AnimationSpeed, Settings } from '../settings/settings';
import { Modal } from './Modal';
import { Button } from './ui';

/** A labelled on/off switch (a checkbox with role="switch"). */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="font-medium">{label}</span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-11 shrink-0 rounded-full bg-surface-3 ring-1 ring-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:right-0.5 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:-translate-x-5"
      />
    </label>
  );
}

function Volume({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
      min={0}
      max={100}
      step={5}
      aria-label={label}
      disabled={disabled}
      value={Math.round(value * 100)}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
      className="w-full accent-[var(--color-accent)] disabled:opacity-40"
    />
  );
}

const SPEEDS: readonly AnimationSpeed[] = ['normal', 'fast'];

/** Gear-icon dialog: sound, music, animation speed, tips. Saved per device. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const store = useSettingsStore();
  const s = useSettings();
  const vibrator = useVibrator();
  const set = (change: (s: Settings) => Settings) => store.update(change);
  const speedLabel = useId();

  return (
    <Modal title={t.settings.title} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <Switch label={t.settings.sfx} checked={s.sfx.enabled} onChange={(enabled) => set((p) => ({ ...p, sfx: { ...p.sfx, enabled } }))} />
          <Volume
            label={t.settings.sfxVolume}
            value={s.sfx.volume}
            disabled={!s.sfx.enabled}
            onChange={(volume) => set((p) => ({ ...p, sfx: { ...p.sfx, volume } }))}
          />
        </section>
        <section className="flex flex-col gap-2">
          <Switch label={t.settings.music} checked={s.music.enabled} onChange={(enabled) => set((p) => ({ ...p, music: { ...p.music, enabled } }))} />
          <Volume
            label={t.settings.musicVolume}
            value={s.music.volume}
            disabled={!s.music.enabled}
            onChange={(volume) => set((p) => ({ ...p, music: { ...p.music, volume } }))}
          />
        </section>
        <section className="flex flex-col gap-2">
          <span id={speedLabel} className="font-medium">
            {t.settings.animationSpeed}
          </span>
          <div role="radiogroup" aria-labelledby={speedLabel} className="grid grid-cols-2 gap-1 rounded-btn bg-bg-0/60 p-1 ring-1 ring-line">
            {SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                role="radio"
                aria-checked={s.animationSpeed === speed}
                onClick={() => set((p) => ({ ...p, animationSpeed: speed }))}
                className={`min-h-11 rounded-[10px] text-sm font-semibold ${
                  s.animationSpeed === speed ? 'bg-accent text-accent-ink' : 'text-muted hover:text-text'
                }`}
              >
                {t.settings.speeds[speed]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{t.settings.reducedMotionNote}</p>
        </section>
        <section className="flex flex-col gap-2">
          <Switch label={t.settings.showTips} checked={s.showTips} onChange={(showTips) => set((p) => ({ ...p, showTips }))} />
          <Button
            variant="secondary"
            className="self-start"
            disabled={s.tipsSeen.length === 0}
            onClick={() => set((p) => ({ ...p, tipsSeen: [] }))}
          >
            {t.settings.resetTips}
          </Button>
        </section>
        <section className="flex flex-col gap-2">
          <Switch
            label={t.settings.showReactions}
            checked={s.showReactions}
            onChange={(showReactions) => set((p) => ({ ...p, showReactions }))}
          />
          {/* Only where the phone can vibrate (Android browsers; never iPhone or desktop). */}
          {vibrator.supported && (
            <Switch label={t.settings.vibration} checked={s.vibration} onChange={(vibration) => set((p) => ({ ...p, vibration }))} />
          )}
        </section>
      </div>
    </Modal>
  );
}

/** The gear icon that opens the settings dialog. */
export function SettingsButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={t.settings.title}
        onClick={() => setOpen(true)}
        className={`grid size-11 shrink-0 place-items-center rounded-full bg-surface/70 text-lg ring-1 ring-line hover:bg-surface-2 ${className}`}
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
