import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AudioEngine } from '../audio/engine';
import { browserLocalStorage, SettingsStore, type Settings } from './settings';

interface Prefs {
  readonly settings: SettingsStore;
  readonly audio: AudioEngine;
}

const PrefsContext = createContext<Prefs | null>(null);

/**
 * Settings (localStorage) and the audio engine for the whole app. Both are injectable for tests;
 * by default a fresh store reads localStorage and the engine uses the browser's AudioContext.
 * Audio is unlocked by the first pointer or key press (browser autoplay policy).
 */
export function PrefsProvider({ settings, audio, children }: { settings?: SettingsStore; audio?: AudioEngine; children: ReactNode }) {
  const [prefs] = useState<Prefs>(() => ({
    settings: settings ?? new SettingsStore(browserLocalStorage()),
    audio: audio ?? new AudioEngine(),
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
