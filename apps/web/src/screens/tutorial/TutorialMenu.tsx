import { Panel } from '../../components/ui';
import { t } from '../../i18n';
import { tutorialPath } from '../../routing';
import { ADVANCED, BASICS, LESSON_IDS, type LessonId } from '../../tutorial/lessons';
import { practiceUnlocked, useTutorialProgress } from '../../tutorial/progress';
import { useTutorialEnv } from '../../tutorial/react';
import { AppLink, PageShell } from '../profile/PageShell';

const ROW =
  'flex min-h-12 w-full items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-start ring-1 ring-line hover:bg-surface-3';

function LessonRow({ id, done }: { id: LessonId; done: boolean }) {
  const n = LESSON_IDS.indexOf(id) + 1;
  return (
    <li>
      <AppLink href={tutorialPath(id)} className={ROW}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="w-5 shrink-0 text-center font-bold text-accent tabular-nums">{n}</span>
          <span className="truncate font-semibold">{t.tutorial.lessons[id].title}</span>
        </span>
        {done && (
          <span className="shrink-0 text-xs text-accent" data-testid={`done-${id}`}>
            ✓ {t.tutorial.completed}
          </span>
        )}
      </AppLink>
    </li>
  );
}

/** /tutorial: the lessons (basics, then the optional advanced ones) and the practice game. */
export function TutorialMenu() {
  const { progress } = useTutorialEnv();
  const p = useTutorialProgress(progress);
  const unlocked = practiceUnlocked(p);
  const done = (id: LessonId) => p.completed.includes(id);
  return (
    <PageShell title={t.tutorial.menuTitle}>
      <p className="text-sm text-muted">{t.tutorial.menuIntro}</p>
      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-bold">{t.tutorial.basics}</h2>
          <p className="text-xs text-muted">{t.tutorial.basicsHint}</p>
        </div>
        <ol className="flex flex-col gap-2">
          {BASICS.map((id) => (
            <LessonRow key={id} id={id} done={done(id)} />
          ))}
        </ol>
        {unlocked ? (
          <AppLink href={tutorialPath('practice')} className={`${ROW} bg-accent/15 ring-accent/50`}>
            <span className="font-bold">▶ {t.tutorial.lessons.practice.title}</span>
          </AppLink>
        ) : (
          <div className={`${ROW} pointer-events-none opacity-60`} aria-disabled="true" data-testid="practice-locked">
            <span className="font-bold">🔒 {t.tutorial.lessons.practice.title}</span>
            <span className="text-xs text-muted">{t.tutorial.practiceLocked}</span>
          </div>
        )}
      </Panel>
      <Panel className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-bold">{t.tutorial.advanced}</h2>
          <p className="text-xs text-muted">{t.tutorial.advancedHint}</p>
        </div>
        <ol className="flex flex-col gap-2">
          {ADVANCED.map((id) => (
            <LessonRow key={id} id={id} done={done(id)} />
          ))}
        </ol>
      </Panel>
    </PageShell>
  );
}
