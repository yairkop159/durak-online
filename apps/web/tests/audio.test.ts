import { describe, expect, it } from 'vitest';
import type { AnimationEvent } from '../src/anim/diffViews';
import { scheduleEvents } from '../src/anim/timeline';
import type { BoardAnimation } from '../src/anim/useBoardAnimation';
import { AudioEngine } from '../src/audio/engine';
import type { Scheduler } from '../src/audio/music';
import { SOUND_NAMES } from '../src/audio/sfx';
import { gameOverCue, soundsFor, tickSecond, turnCue } from '../src/audio/soundPlan';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings/settings';
import { c } from './helpers';

/** A recording stand-in for AudioContext: counts the sources it starts and when. */
class FakeAudioContext {
  currentTime = 10;
  sampleRate = 8000;
  state: AudioContextState = 'suspended';
  readonly destination = { node: 'destination' };
  readonly starts: { kind: 'osc' | 'noise'; at: number }[] = [];
  resumed = 0;

  private param() {
    return {
      value: 0,
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
      linearRampToValueAtTime() {},
      setTargetAtTime(this: { value: number }, v: number) {
        this.value = v;
      },
    };
  }
  private node<T extends object>(extra: T) {
    return { ...extra, connect: (n: unknown) => n };
  }
  createGain() {
    return this.node({ gain: this.param() });
  }
  createOscillator() {
    return this.node({ type: 'sine', frequency: this.param(), start: (at: number) => this.starts.push({ kind: 'osc', at }), stop() {} });
  }
  createBiquadFilter() {
    return this.node({ type: 'lowpass', frequency: this.param(), Q: this.param() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    return this.node({ buffer: null, start: (at: number) => this.starts.push({ kind: 'noise', at }) });
  }
  resume() {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const manualScheduler = (): Scheduler & { running: number } => {
  const s = {
    running: 0,
    setInterval: () => {
      s.running++;
      return s.running;
    },
    clearInterval: () => {
      s.running--;
    },
  };
  return s;
};

function engine(settings: Settings = DEFAULT_SETTINGS) {
  const ctx = new FakeAudioContext();
  const scheduler = manualScheduler();
  const audio = new AudioEngine(() => ctx as unknown as AudioContext, scheduler);
  audio.setSettings(settings);
  return { ctx, audio, scheduler };
}

describe('AudioEngine', () => {
  it('plays nothing before the first user gesture (autoplay policy), then resumes the context', () => {
    const { ctx, audio } = engine();
    audio.play('cardPlay');
    expect(ctx.starts).toHaveLength(0);
    audio.unlock();
    expect(ctx.resumed).toBe(1);
    audio.play('cardPlay', 250);
    expect(ctx.starts.length).toBeGreaterThan(0);
    expect(ctx.starts.every((s) => s.at === 10.25)).toBe(true);
  });

  it('every sound is synthesized (no files) and schedules at least one source', () => {
    const { ctx, audio } = engine();
    audio.unlock();
    for (const name of SOUND_NAMES) {
      const before = ctx.starts.length;
      audio.play(name);
      expect(ctx.starts.length, name).toBeGreaterThan(before);
    }
  });

  it('sound effects off: silent', () => {
    const { ctx, audio } = engine({ ...DEFAULT_SETTINGS, sfx: { enabled: false, volume: 0.7 } });
    audio.unlock();
    audio.play('win');
    expect(ctx.starts).toHaveLength(0);
  });

  it('music is off by default, starts when enabled and stops when disabled', () => {
    const { ctx, audio, scheduler } = engine();
    audio.unlock();
    expect(audio.musicPlaying).toBe(false);
    expect(ctx.starts).toHaveLength(0);

    audio.setSettings({ ...DEFAULT_SETTINGS, music: { enabled: true, volume: 0.3 } });
    expect(audio.musicPlaying).toBe(true);
    expect(scheduler.running).toBe(1);
    expect(ctx.starts.some((s) => s.kind === 'osc')).toBe(true); // the first notes are queued at once

    audio.setSettings(DEFAULT_SETTINGS);
    expect(audio.musicPlaying).toBe(false);
    expect(scheduler.running).toBe(0);
  });

  it('without Web Audio every call is a no-op', () => {
    const audio = new AudioEngine(() => null);
    audio.setSettings(DEFAULT_SETTINGS);
    audio.unlock();
    expect(() => audio.play('durak')).not.toThrow();
    expect(audio.unlocked).toBe(false);
  });
});

const anim = (events: AnimationEvent[], speed = 1): BoardAnimation => ({
  version: 1,
  events,
  timeline: scheduleEvents(events, { reduced: false, speed }),
  reduced: false,
  reveal: new Map(),
});

describe('sound plan (driven by the animation events)', () => {
  const closing: AnimationEvent = { type: 'played', by: 'bob', from: { kind: 'seat', playerId: 'bob' }, card: c('9S'), kind: 'defend', slot: { index: 0, role: 'defense' } };

  it('a closing defense, the sweep, then the draws, each at its animation time', () => {
    const events: AnimationEvent[] = [
      closing,
      { type: 'beaten', cards: [c('8S'), c('9S')] },
      { type: 'drawn', player: 'me', to: { kind: 'myHand' }, count: 2, cards: [c('6H'), c('7H')], includesTrump: false },
    ];
    const a = anim(events);
    const plan = soundsFor(a);
    expect(plan.map((p) => p.sound)).toEqual(['defend', 'sweep', 'draw', 'draw']);
    expect(plan[0]!.atMs).toBe(0);
    expect(plan[1]!.atMs).toBe(a.timeline.items[1]!.startMs);
    expect(plan[3]!.atMs).toBeGreaterThan(plan[2]!.atMs);
  });

  it('an attack is a card play, a take is a take; fast animations bring the sounds forward', () => {
    const taken: AnimationEvent = { type: 'taken', by: 'bob', to: { kind: 'seat', playerId: 'bob' }, cards: [c('8S')] };
    const attack: AnimationEvent = { ...closing, kind: 'attack', slot: { index: 1, role: 'attack' } };
    expect(soundsFor(anim([attack, taken])).map((p) => p.sound)).toEqual(['cardPlay', 'take']);
    expect(soundsFor(anim([attack, taken], 0.6))[1]!.atMs).toBeLessThan(soundsFor(anim([attack, taken]))[1]!.atMs);
  });

  it('cues: the turn chime on the change only, ticks once per second in the last 5 s, stingers per viewer', () => {
    expect(turnCue(false, true)).toBe('yourTurn');
    expect(turnCue(true, true)).toBeNull();
    expect(tickSecond(5200, true)).toBeNull();
    expect(tickSecond(4900, true)).toBe(5);
    expect(tickSecond(4100, true)).toBe(5);
    expect(tickSecond(3900, true)).toBe(4);
    expect(tickSecond(3900, false)).toBeNull();

    const over = { roomId: 'r', durakId: 'me', finishOrder: [], endReason: 'normal' as const, botAssisted: [], forfeits: [] };
    expect(gameOverCue(over, 'me')).toBe('durak');
    expect(gameOverCue(over, 'bob')).toBe('win');
    expect(gameOverCue(over, null)).toBeNull();
    expect(gameOverCue({ ...over, endReason: 'restarted', durakId: null }, 'me')).toBeNull();
  });
});
