/**
 * Short vibrations for moments that matter when the phone is in a pocket or on the table:
 * "your turn" and the game's end. The Vibration API exists on Android browsers only (never on
 * iPhone) and works only after the user has interacted with the page; everywhere else it is a no-op.
 */
export type HapticCue = 'yourTurn' | 'win' | 'durak';

export const VIBRATION_PATTERNS: Record<HapticCue, readonly number[]> = {
  yourTurn: [60],
  win: [80, 60, 80],
  durak: [200, 80, 200],
};

export interface VibrateNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
}

export interface Vibrator {
  readonly supported: boolean;
  vibrate(cue: HapticCue): void;
}

export function createVibrator(nav: VibrateNavigator | undefined): Vibrator {
  const supported = !!nav && typeof nav.vibrate === 'function';
  return {
    supported,
    vibrate(cue) {
      if (!supported) return;
      try {
        nav!.vibrate!([...VIBRATION_PATTERNS[cue]]);
      } catch {
        // Some browsers throw instead of returning false (e.g. no user activation yet).
      }
    },
  };
}

export function browserVibrator(): Vibrator {
  return createVibrator(typeof navigator !== 'undefined' ? (navigator as VibrateNavigator) : undefined);
}
