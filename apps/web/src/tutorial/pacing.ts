import { t } from '../i18n';
import { isCardPart, type Rich } from './rich';
import type { TutorialGameId } from './lessons';

/** An opponent's move is shown this long after the previous change (× the animation speed). */
export const OPPONENT_DELAY_MS = 900;
/** After a bout resolution: the client's ≤ 1.2 s resolution animation finishes first. */
export const OPPONENT_DELAY_AFTER_BOUT_MS = 1_400;

/**
 * The "learn in 5 minutes" estimate. Conservative on purpose: a newcomer reads Hebrew at about
 * 150 words a minute, thinks 6 s before each move or tap, and needs 2 s to press "next".
 */
export const READING_WPM = 150;
export const THINK_MS = 6_000;
export const NEXT_MS = 2_000;
/** A bout resolution animates for up to this long before the next step is shown. */
export const RESOLUTION_MS = 1_200;

/** A card counts as one word ("8♣"). */
export function wordCount(text: Rich): number {
  return text.reduce((n, part) => n + (isCardPart(part) ? 1 : part.split(/\s+/).filter(Boolean).length), 0);
}

/** What a learner reads in a lesson that goes right the first time: title, goal, hint, success. */
export function lessonWords(id: TutorialGameId): number {
  const l = t.tutorial.lessons[id];
  return wordCount([l.title]) + wordCount(l.goal) + wordCount(l.hint) + wordCount(l.success);
}

/** What happened while playing a lesson's solution (counted by the pacing test from the real machine). */
export interface LessonTrace {
  /** My moves and taps. */
  readonly actions: number;
  readonly opponentMoves: number;
  /** Opponent moves that came right after a bout resolution (the longer delay). */
  readonly opponentMovesAfterBout: number;
  readonly resolutions: number;
}

export interface LessonEstimate {
  readonly readMs: number;
  readonly thinkMs: number;
  readonly waitMs: number;
  readonly totalMs: number;
}

export function estimateLesson(id: TutorialGameId, trace: LessonTrace): LessonEstimate {
  const readMs = Math.round((lessonWords(id) / READING_WPM) * 60_000);
  const thinkMs = trace.actions * THINK_MS + NEXT_MS;
  const waitMs =
    (trace.opponentMoves - trace.opponentMovesAfterBout) * OPPONENT_DELAY_MS +
    trace.opponentMovesAfterBout * OPPONENT_DELAY_AFTER_BOUT_MS +
    trace.resolutions * RESOLUTION_MS;
  return { readMs, thinkMs, waitMs, totalMs: readMs + thinkMs + waitMs };
}
