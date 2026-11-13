/**
 * Every sound effect, synthesized with the Web Audio API (no audio files). Each recipe schedules
 * a few short-lived nodes at `t` (AudioContext time, seconds) into `out`.
 */
export const SOUND_NAMES = ['cardPlay', 'defend', 'take', 'sweep', 'draw', 'yourTurn', 'tick', 'win', 'durak'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

type Recipe = (ctx: AudioContext, out: AudioNode, t: number, noise: AudioBuffer) => void;

interface ToneSpec {
  readonly freq: number;
  /** Glide target (exponential), if any. */
  readonly freqEnd?: number;
  readonly type?: OscillatorType;
  readonly dur: number;
  readonly gain: number;
  readonly attack?: number;
}

function tone(ctx: AudioContext, out: AudioNode, t: number, spec: ToneSpec): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = spec.type ?? 'sine';
  osc.frequency.setValueAtTime(spec.freq, t);
  if (spec.freqEnd) osc.frequency.exponentialRampToValueAtTime(spec.freqEnd, t + spec.dur);
  const attack = spec.attack ?? 0.005;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(spec.gain, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + spec.dur + 0.02);
}

interface NoiseSpec {
  readonly dur: number;
  readonly gain: number;
  readonly filter: BiquadFilterType;
  readonly freq: number;
  /** Filter frequency glide target, if any. */
  readonly freqEnd?: number;
  readonly q?: number;
}

function noiseBurst(ctx: AudioContext, out: AudioNode, t: number, noise: AudioBuffer, spec: NoiseSpec): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = spec.filter;
  filter.frequency.setValueAtTime(spec.freq, t);
  if (spec.freqEnd) filter.frequency.exponentialRampToValueAtTime(spec.freqEnd, t + spec.dur);
  filter.Q.value = spec.q ?? 1;
  const env = ctx.createGain();
  env.gain.setValueAtTime(spec.gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
  src.connect(filter).connect(env).connect(out);
  // Start somewhere inside the 1 s buffer so repeated bursts don't sound identical.
  src.start(t, (t * 7.31) % 0.5, spec.dur + 0.02);
}

const notes = (ctx: AudioContext, out: AudioNode, t: number, freqs: readonly number[], step: number, spec: Omit<ToneSpec, 'freq'>) =>
  freqs.forEach((freq, i) => tone(ctx, out, t + i * step, { ...spec, freq }));

export const RECIPES: Record<SoundName, Recipe> = {
  // A card slapped on the felt: a short papery burst over a soft thump.
  cardPlay: (ctx, out, t, noise) => {
    noiseBurst(ctx, out, t, noise, { dur: 0.07, gain: 0.5, filter: 'bandpass', freq: 2400, q: 0.8 });
    tone(ctx, out, t, { freq: 170, freqEnd: 80, dur: 0.08, gain: 0.35 });
  },
  // Covering a card: brighter, with a little "tick" on top.
  defend: (ctx, out, t, noise) => {
    noiseBurst(ctx, out, t, noise, { dur: 0.06, gain: 0.45, filter: 'bandpass', freq: 3600, q: 1.2 });
    tone(ctx, out, t, { freq: 620, freqEnd: 520, type: 'triangle', dur: 0.09, gain: 0.12 });
  },
  // Picking up the pile: a falling, heavier slide.
  take: (ctx, out, t, noise) => {
    noiseBurst(ctx, out, t, noise, { dur: 0.32, gain: 0.4, filter: 'lowpass', freq: 2200, freqEnd: 400 });
    tone(ctx, out, t, { freq: 240, freqEnd: 110, dur: 0.3, gain: 0.18 });
  },
  // Beaten cards swept off the table: a rising whoosh.
  sweep: (ctx, out, t, noise) => {
    noiseBurst(ctx, out, t, noise, { dur: 0.35, gain: 0.35, filter: 'bandpass', freq: 600, freqEnd: 4000, q: 0.7 });
  },
  // One card drawn from the deck: a tiny flick.
  draw: (ctx, out, t, noise) => {
    noiseBurst(ctx, out, t, noise, { dur: 0.04, gain: 0.22, filter: 'highpass', freq: 3500 });
  },
  // Your turn: a soft two-note chime.
  yourTurn: (ctx, out, t) => {
    notes(ctx, out, t, [659.25, 987.77], 0.12, { type: 'sine', dur: 0.35, gain: 0.18, attack: 0.01 });
  },
  // Last seconds: a short wooden tick.
  tick: (ctx, out, t) => {
    tone(ctx, out, t, { freq: 1250, type: 'square', dur: 0.03, gain: 0.05 });
  },
  // You did not lose: a bright rising arpeggio.
  win: (ctx, out, t) => {
    notes(ctx, out, t, [523.25, 659.25, 783.99, 1046.5], 0.11, { type: 'triangle', dur: 0.45, gain: 0.2, attack: 0.01 });
  },
  // You are the durak: a sad, sliding descent.
  durak: (ctx, out, t) => {
    notes(ctx, out, t, [392, 349.23, 311.13], 0.22, { type: 'triangle', dur: 0.4, gain: 0.2, attack: 0.02 });
    tone(ctx, out, t + 0.66, { freq: 293.66, freqEnd: 196, type: 'triangle', dur: 0.8, gain: 0.2, attack: 0.02 });
  },
};

/** One second of white noise, made once per AudioContext. */
export function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return buffer;
}
