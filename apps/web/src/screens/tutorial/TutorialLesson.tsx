import { cardId, sameCard, type Card } from '@durak/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CardState } from '../../components/cards/PlayingCard';
import { t } from '../../i18n';
import { useLayoutMode } from '../../layout/layoutMode';
import { navigate, tutorialPath, TUTORIAL_PATH } from '../../routing';
import { useSettings } from '../../settings/react';
import { ANIMATION_SPEED_FACTOR } from '../../settings/settings';
import { TutorialDriver, tutorialMembers } from '../../tutorial/driver';
import { BASICS, LESSON_IDS, lesson, type TutorialGameId } from '../../tutorial/lessons';
import { takesTap } from '../../tutorial/machine';
import { practiceUnlocked, useTutorialProgress } from '../../tutorial/progress';
import { useTutorialEnv } from '../../tutorial/react';
import type { TableSource } from '../table/source';
import { TableScreen } from '../table/TableScreen';
import { GuidePanel, type GuideAction } from './GuidePanel';

/** Where "next" goes after a lesson: the next lesson; after the basics the practice game; then the menu. */
export function nextAfter(id: TutorialGameId, practiceOpen: boolean): string {
  if (id === 'practice' || id === LESSON_IDS.at(-1)) return TUTORIAL_PATH;
  if (id === BASICS.at(-1)) return practiceOpen ? tutorialPath('practice') : TUTORIAL_PATH;
  return tutorialPath(LESSON_IDS[LESSON_IDS.indexOf(id) + 1]!);
}

/** /tutorial/:lesson — one lesson (or the practice game) on the real table, driven locally. */
export function TutorialLesson({ id }: { id: TutorialGameId }) {
  const env = useTutorialEnv();
  const progressNow = useTutorialProgress(env.progress);
  const settings = useSettings();
  const speedRef = useRef(settings.animationSpeed);
  speedRef.current = settings.animationSpeed;
  const short = useLayoutMode() === 'short';

  const [driver] = useState(
    () =>
      new TutorialDriver(id, {
        seed: id === 'practice' ? env.practiceSeed() : 1,
        ...(env.schedule ? { schedule: env.schedule } : {}),
        speed: () => ANIMATION_SPEED_FACTOR[speedRef.current],
        onSuccess: (done) => {
          if (done !== 'practice') env.progress.complete(done);
        },
      }),
  );
  useEffect(() => {
    driver.start();
    return () => driver.stop();
  }, [driver]);
  const snap = useSyncExternalStore(driver.subscribe, driver.getSnapshot, driver.getSnapshot);
  const { tutorial, game, gameOver } = snap;
  const def = lesson(id);
  const text = t.tutorial.lessons[id];
  const members = useMemo(() => tutorialMembers(id, t.tutorial.names, t.common.you), [id]);

  const practiceOpen = practiceUnlocked(progressNow);
  const next = nextAfter(id, practiceOpen || (id === BASICS.at(-1) && tutorial.phase === 'success' && practiceUnlocked(env.progress.get())));
  const toNext: GuideAction = { label: next === TUTORIAL_PATH ? t.tutorial.toMenu : t.tutorial.next, run: () => navigate(next) };
  const retry: GuideAction = { label: t.tutorial.tryAgain, run: () => driver.dispatch({ type: 'retry' }) };
  const dismiss: GuideAction = { label: t.tutorial.tryAgain, run: () => driver.dispatch({ type: 'dismiss' }) };

  const phase = tutorial.phase;
  const trump = tutorial.game.trumpCard.suit;
  const feedback =
    phase === 'success' ? text.success : (phase === 'wrong' || phase === 'failed') && tutorial.reason ? t.tutorial.reason(tutorial.reason, trump) : null;
  const goal = def.goal;
  const number = id === 'practice' ? null : LESSON_IDS.indexOf(id) + 1;
  const heading = number === null ? text.title : `${t.tutorial.lessonOf(number, LESSON_IDS.length)} · ${text.title}`;
  const finished = tutorial.game.phase.kind === 'finished';

  const panel = (
    <GuidePanel
      key={`${id}#${tutorial.attempt}`}
      heading={heading}
      phase={phase}
      goal={text.goal}
      hint={text.hint}
      feedback={feedback}
      progressNote={goal.kind === 'pick' && phase === 'playing' && tutorial.picked.length > 0 ? t.tutorial.picked(tutorial.picked.length, goal.cards.length) : null}
      primary={phase === 'wrong' ? dismiss : phase === 'failed' ? retry : phase === 'success' ? toNext : null}
      secondary={phase === 'success' && id !== 'practice' ? { label: t.tutorial.toMenu, run: () => navigate(TUTORIAL_PATH) } : null}
      onSkip={id === 'practice' ? null : () => navigate(nextAfter(id, practiceOpen))}
      compact={short}
    />
  );

  // Only the cards the lesson is about are highlighted (the other legal ones still work, unlit).
  const focus = useMemo(() => {
    const list = def.focus?.(tutorial.game);
    return list ? new Set(list.map(cardId)) : null;
  }, [def, tutorial.game]);
  const handCardState = (c: Card, base: CardState): CardState => {
    if (goal.kind === 'pick') {
      if (base === 'plain') return base;
      return tutorial.picked.some((p) => sameCard(p, c)) ? 'selected' : 'playable';
    }
    return base === 'playable' && focus && !focus.has(cardId(c)) ? 'plain' : base;
  };

  const source: TableSource = {
    game,
    members,
    room: null,
    gameOver,
    ratings: null,
    lastError: null,
    reconnecting: false,
    now: driver.now,
    sendMove: (move) => driver.dispatch({ type: 'move', move }),
    leave: { outcome: 'none', run: () => navigate(TUTORIAL_PATH) },
    guide: {
      panel,
      blocked: phase !== 'playing',
      handCardState,
      onHandTap: (c, playable) => {
        if (!takesTap(tutorial, playable)) return false;
        driver.dispatch({ type: 'tap', card: c, playable });
        return true;
      },
      highlightTrump: def.highlightTrump ?? false,
      ...(finished
        ? { gameOverAction: phase === 'failed' ? retry : toNext }
        : {}),
    },
  };
  return <TableScreen source={source} />;
}
