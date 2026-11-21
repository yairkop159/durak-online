import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { BASICS, LESSON_IDS, type LessonId } from '../src/tutorial/lessons';
import { startLesson, tutorialReducer } from '../src/tutorial/machine';
import { estimateLesson, lessonWords, type LessonTrace } from '../src/tutorial/pacing';
import { drain, solutionOf } from './tutorialSolutions';

/** Plays a lesson's solution through the real machine and counts what the learner waits for. */
function traceOf(id: LessonId): LessonTrace {
  let state = startLesson(id);
  let opponentMoves = 0;
  let opponentMovesAfterBout = 0;
  let resolutions = 0;
  let lastChangeResolved = false;
  const events = solutionOf(id);
  for (const event of events) {
    const next = tutorialReducer(state, event);
    lastChangeResolved = next.game.boutNumber !== state.game.boutNumber;
    if (lastChangeResolved) resolutions++;
    state = drain(next, (prev, after) => {
      opponentMoves++;
      if (lastChangeResolved) opponentMovesAfterBout++;
      lastChangeResolved = after.game.boutNumber !== prev.game.boutNumber;
      if (lastChangeResolved) resolutions++;
    });
  }
  expect(state.phase, id).toBe('success');
  return { actions: events.length, opponentMoves, opponentMovesAfterBout, resolutions };
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

describe('"learn in 5 minutes": measured on the real lessons', () => {
  const rows = LESSON_IDS.map((id) => {
    const trace = traceOf(id);
    return { id, words: lessonWords(id), trace, estimate: estimateLesson(id, trace) };
  });
  const basicsMs = rows.filter((r) => BASICS.includes(r.id)).reduce((sum, r) => sum + r.estimate.totalMs, 0);

  it('the basics take at most 5 minutes (conservative reading, thinking and waiting)', () => {
    const table = rows.map(
      (r) =>
        `${r.id.padEnd(13)} words ${String(r.words).padStart(3)}  actions ${r.trace.actions}  bot moves ${r.trace.opponentMoves}  ` +
        `read ${seconds(r.estimate.readMs).padStart(5)} s  think ${seconds(r.estimate.thinkMs).padStart(5)} s  wait ${seconds(r.estimate.waitMs).padStart(4)} s  = ${seconds(r.estimate.totalMs).padStart(5)} s`,
    );
    console.log(`${table.join('\n')}\nbasics total: ${seconds(basicsMs)} s`);
    expect(basicsMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('no single lesson drags (each well under a minute)', () => {
    for (const r of rows) expect(r.estimate.totalMs, r.id).toBeLessThan(60_000);
  });

  it('counts every text the learner reads', () => {
    expect(lessonWords('take')).toBeGreaterThan(t.tutorial.lessons.take.title.split(' ').length);
  });
});
