/**
 * Quiet generative background music (Web Audio only): a slow pad over a four-chord loop and a
 * sparse plucked melody walking an A-minor pentatonic scale. A lookahead scheduler queues notes
 * a little ahead of time, so timer jitter never makes it stutter.
 */

const BEAT_S = 0.75;
const BEATS_PER_CHORD = 8;
const LOOKAHEAD_S = 1.5;
const TICK_MS = 250;

// Am, F, C, G (pad voicings, Hz).
const CHORDS: readonly (readonly number[])[] = [
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [196, 261.63, 329.63],
  [196, 246.94, 293.66],
];
// A minor pentatonic, two octaves.
const SCALE = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66];

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class GenerativeMusic {
  private handle: unknown = null;
  private nextBeatAt = 0;
  private beat = 0;
  private step = 3;
  private seed = 0x2f6b;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
    private readonly scheduler: Scheduler = browserScheduler,
  ) {}

  get playing(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.nextBeatAt = this.ctx.currentTime + 0.1;
    this.handle = this.scheduler.setInterval(() => this.fill(), TICK_MS);
    this.fill();
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  private fill(): void {
    while (this.nextBeatAt < this.ctx.currentTime + LOOKAHEAD_S) {
      const t = this.nextBeatAt;
      if (this.beat % BEATS_PER_CHORD === 0) this.pad(CHORDS[(this.beat / BEATS_PER_CHORD) % CHORDS.length]!, t);
      // A note on roughly half the beats, wandering by small steps.
      if (this.random() < 0.5) {
        this.step = Math.min(SCALE.length - 1, Math.max(0, this.step + Math.round(this.random() * 4 - 2)));
        this.pluck(SCALE[this.step]!, t);
      }
      this.beat++;
      this.nextBeatAt += BEAT_S;
    }
  }

  private pad(chord: readonly number[], t: number): void {
    const dur = BEAT_S * BEATS_PER_CHORD;
    for (const freq of chord) {
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.05, t + 1.5);
      env.gain.linearRampToValueAtTime(0.0001, t + dur + 0.5);
      osc.connect(env).connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.6);
    }
  }

  private pluck(freq: number, t: number): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    osc.connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + 1.25);
  }
}
