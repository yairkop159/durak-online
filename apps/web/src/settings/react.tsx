import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AudioEngine } from '../audio/engine';
import { browserVibrator, type HapticCue, type Vibrator } from '../phone/vibrate';
import { browserLocalStorage, SettingsStore, type Settings } from './settings';

interface Prefs {
  readonly settings: SettingsStore;
  readonly audio: AudioEngine;
  readonly vibrator: Vibrator;
}

const PrefsContext = createContext<Prefs | null>(null);

/**
 * Settings (localStorage) and the audio engine for the whole app. Both are injectable for tests;
 * by default a fresh store reads localStorage and the engine uses the browser's AudioContext.
 * Audio is unlocked by the first pointer or key press (browser autoplay policy).
 */
export function PrefsProvider({
  settings,
  audio,
  vibrator,
  children,
}: {
  settings?: SettingsStore;
  audio?: AudioEngine;
  vibrator?: Vibrator;
  children: ReactNode;
}) {
  const [prefs] = useState<Prefs>(() => ({
    settings: settings ?? new SettingsStore(browserLocalStorage()),
    audio: audio ?? new AudioEngine(),
    vibrator: vibrator ?? browserVibrator(),
  }));

  useEffect(() => {
    const { settings: store, audio: engine } = prefs;
    engine.setSettings(store.get());
    const unsubscribe = store.subscribe(() => engine.setSettings(store.get()));
    const unlock = () => engine.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      unsubscribe();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [prefs]);

  return <PrefsContext.Provider value={prefs}>{children}</PrefsContext.Provider>;
}

function usePrefs(): Prefs {
  const prefs = useContext(PrefsContext);
  if (!prefs) throw new Error('usePrefs outside <PrefsProvider>');
  return prefs;
}

export function useSettingsStore(): SettingsStore {
  return usePrefs().settings;
}

export function useSettings(): Settings {
  const store = useSettingsStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useAudio(): AudioEngine {
  return usePrefs().audio;
}

export function useVibrator(): Vibrator {
  return usePrefs().vibrator;
}

/**
 * Vibrates for `cue` when the setting is on and the page is visible (a background tab must not
 * buzz). A no-op where vibration is unsupported (iPhone, desktop).
 */
export function useHaptic(): (cue: HapticCue) => void {
  const vibrator = useVibrator();
  const { vibration } = useSettings();
  return useCallback(
    (cue: HapticCue) => {
      if (vibration && (typeof document === 'undefined' || document.visibilityState === 'visible')) vibrator.vibrate(cue);
    },
    [vibrator, vibration],
  );
}
