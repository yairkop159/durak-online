import type { GameOverPayload } from '@durak/shared';
import type { BoardAnimation } from '../anim/useBoardAnimation';
import type { MomentType } from '../anim/moments';
import { cardStart } from '../anim/timeline';
import type { SoundName } from './sfx';

export interface PlannedSound {
  readonly sound: SoundName;
  /** Milliseconds after the state arrived (matches the animation timeline). */
  readonly atMs: number;
}

/** Most draw ticks played for one refill (more would just be noise). */
const MAX_DRAW_TICKS = 6;

/** The sound each moment banner opens with. */
export const MOMENT_SOUNDS: Record<MomentType, SoundName> = {
  wentOut: 'wentOut',
  deckOut: 'deckOut',
  bigTake: 'bigTake',
  transfer: 'transfer',
  perfectDefense: 'perfect',
};

/**
 * The sounds of one board animation, timed with its timeline (pure). Driven only by the
 * `diffViews` events the animations already use: no extra server messages. Moment banners play
 * their own sound when they actually appear (they can queue), see `MOMENT_SOUNDS`.
 */
export function soundsFor(anim: BoardAnimation): PlannedSound[] {
  const out: PlannedSound[] = [];
  let draws = 0;
  for (const item of anim.timeline.items) {
    const e = item.event;
    switch (e.type) {
      case 'played':
        out.push({ sound: e.slot.role === 'defense' ? 'defend' : 'cardPlay', atMs: item.startMs });
        break;
      case 'beaten':
        out.push({ sound: 'sweep', atMs: item.startMs });
        break;
      case 'taken':
        out.push({ sound: 'take', atMs: item.startMs });
        break;
      case 'drawn':
        for (let k = 0; k < e.count && draws < MAX_DRAW_TICKS; k++, draws++) {
          out.push({ sound: 'draw', atMs: cardStart(item, k) });
        }
        break;
      case 'deck':
        break;
    }
  }
  return out;
}

/** The chime when it becomes my turn (not on every re-render while it stays my turn). */
export function turnCue(wasMyTurn: boolean, isMyTurn: boolean): SoundName | null {
  return !wasMyTurn && isMyTurn ? 'yourTurn' : null;
}

/** Ticks in the last 5 seconds of my turn: once per whole second shown. */
export const TICK_FROM_MS = 5000;
export function tickSecond(remainingMs: number | null, isMyTurn: boolean): number | null {
  if (!isMyTurn || remainingMs === null || remainingMs <= 0 || remainingMs > TICK_FROM_MS) return null;
  return Math.ceil(remainingMs / 1000);
}

/** The end-of-game stinger from the viewer's point of view (none for spectators or non-results). */
export function gameOverCue(gameOver: GameOverPayload, viewerId: string | null): SoundName | null {
  if (viewerId === null || gameOver.endReason === 'abandoned' || gameOver.endReason === 'restarted') return null;
  return gameOver.durakId === viewerId ? 'durak' : 'win';
}
