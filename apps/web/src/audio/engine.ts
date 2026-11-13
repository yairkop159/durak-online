import type { Settings } from '../settings/settings';
import { GenerativeMusic, type Scheduler } from './music';
import { makeNoise, RECIPES, type SoundName } from './sfx';

export type AudioContextFactory = () => AudioContext | null;

const browserAudioContext: AudioContextFactory = () => {
  try {
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
};

interface Graph {
  readonly ctx: AudioContext;
  readonly sfx: GainNode;
  readonly music: GainNode;
  readonly noise: AudioBuffer;
  readonly generative: GenerativeMusic;
}

/**
 * All game audio. Nothing is created before `unlock()` (the first user gesture; browsers block
 * audio until then), and without Web Audio (or in tests) every call is a no-op.
 * Two buses: sound effects and music, each with its own on/off + volume from the settings.
 */
export class AudioEngine {
  private graph: Graph | null = null;
  private settings: Settings | null = null;

  constructor(
    private readonly factory: AudioContextFactory = browserAudioContext,
    private readonly musicScheduler?: Scheduler,
  ) {}

  get unlocked(): boolean {
    return this.graph !== null;
  }

  /** Call from a user gesture. Creates the context on first use and resumes it if suspended. */
  unlock(): void {
    if (!this.graph) {
      const ctx = this.factory();
      if (!ctx) return;
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const sfx = ctx.createGain();
      const music = ctx.createGain();
      sfx.connect(master);
      music.connect(master);
      this.graph = { ctx, sfx, music, noise: makeNoise(ctx), generative: new GenerativeMusic(ctx, music, this.musicScheduler) };
      if (this.settings) this.apply(this.settings);
    }
    if (this.graph.ctx.state === 'suspended') void this.graph.ctx.resume().catch(() => undefined);
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    if (this.graph) this.apply(settings);
  }

  /** Plays `sound` `atMs` from now (no-op before unlock or with sound effects off). */
  play(sound: SoundName, atMs = 0): void {
    const g = this.graph;
    if (!g || !this.settings?.sfx.enabled || this.settings.sfx.volume <= 0) return;
    RECIPES[sound](g.ctx, g.sfx, g.ctx.currentTime + Math.max(0, atMs) / 1000, g.noise);
  }

  get musicPlaying(): boolean {
    return this.graph?.generative.playing ?? false;
  }

  dispose(): void {
    this.graph?.generative.stop();
    void this.graph?.ctx.close().catch(() => undefined);
    this.graph = null;
  }

  private apply(s: Settings): void {
    const g = this.graph!;
    const now = g.ctx.currentTime;
    g.sfx.gain.setTargetAtTime(s.sfx.enabled ? s.sfx.volume : 0, now, 0.02);
    g.music.gain.setTargetAtTime(s.music.enabled ? s.music.volume : 0, now, 0.3);
    if (s.music.enabled && s.music.volume > 0) g.generative.start();
    else g.generative.stop();
  }
}
