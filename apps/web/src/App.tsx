import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import type { AudioEngine } from './audio/engine';
import { ConnectionBanner, ErrorToast, NoticeToast } from './components/ui';
import { PrefsProvider } from './settings/react';
import type { SettingsStore } from './settings/settings';
import type { Vibrator } from './phone/vibrate';
import { useClient, useClientState } from './net/react';
import { isReconnecting } from './net/store';
import { useRoute } from './routing';
import { HomeScreen } from './screens/HomeScreen';
import { RoomRoute, showsTable } from './screens/RoomRoute';
import { RulesScreen } from './screens/rules/RulesScreen';
import { LeaderboardScreen } from './screens/profile/LeaderboardScreen';
import { ProfileScreen } from './screens/profile/ProfileScreen';
import { ProfilesProvider, type Profiles } from './profile/react';
import { TutorialProvider, useTutorialEnv, type TutorialEnv } from './tutorial/react';
import { isLessonId, type TutorialGameId } from './tutorial/lessons';
import { practiceUnlocked, useTutorialProgress } from './tutorial/progress';
import { TutorialMenu } from './screens/tutorial/TutorialMenu';
import { TutorialLesson } from './screens/tutorial/TutorialLesson';

/**
 * `settings` / `audio` / `vibrator` / `profiles` / `tutorial` are injectable for tests (default:
 * localStorage, Web Audio, navigator.vibrate, the server's /api, setTimeout pacing).
 */
export function App({
  settings,
  audio,
  vibrator,
  profiles,
  tutorial,
}: { settings?: SettingsStore; audio?: AudioEngine; vibrator?: Vibrator; profiles?: Profiles; tutorial?: Partial<TutorialEnv> } = {}) {
  return (
    <PrefsProvider {...(settings ? { settings } : {})} {...(audio ? { audio } : {})} {...(vibrator ? { vibrator } : {})}>
      <ProfilesProvider {...(profiles ? { profiles } : {})}>
        <TutorialProvider {...(tutorial ? { env: tutorial } : {})}>
          <AppShell />
        </TutorialProvider>
      </ProfilesProvider>
    </PrefsProvider>
  );
}

/** The lesson a /tutorial/:lesson route may open (practice only once the basics are done), or null = the menu. */
function useTutorialLesson(route: ReturnType<typeof useRoute>): TutorialGameId | null {
  const { progress } = useTutorialEnv();
  const p = useTutorialProgress(progress);
  if (route.name !== 'tutorial' || route.lesson === null) return null;
  if (route.lesson === 'practice') return practiceUnlocked(p) ? 'practice' : null;
  return isLessonId(route.lesson) ? route.lesson : null;
}

function Screen({ route, lesson }: { route: ReturnType<typeof useRoute>; lesson: TutorialGameId | null }) {
  switch (route.name) {
    case 'tutorial':
      // A new lesson (or a replay after leaving) gets a fresh local game.
      return lesson ? <TutorialLesson key={lesson} id={lesson} /> : <TutorialMenu />;
    case 'room':
      return <RoomRoute roomId={route.roomId} />;
    case 'rules':
      return <RulesScreen />;
    case 'profile':
      return <ProfileScreen key={route.profileId ?? 'me'} profileId={route.profileId} />;
    case 'leaderboard':
      return <LeaderboardScreen />;
    case 'home':
      return <HomeScreen />;
  }
}

function AppShell() {
  const client = useClient();
  const route = useRoute();
  const roomId = route.name === 'room' ? route.roomId : null;
  // While the seat is being re-bound nothing in the room may be clicked (the banner says why).
  const state = useClientState();
  const reconnecting = isReconnecting(state);
  // The game table always fits one screen (it never scrolls); the other screens scroll normally.
  const lesson = useTutorialLesson(route);
  const fitScreen = (roomId !== null && showsTable(state, roomId)) || lesson !== null;

  useEffect(() => {
    client.setRoute(roomId);
  }, [client, roomId]);

  return (
    // reducedMotion="user": with prefers-reduced-motion, Framer skips transform/layout animations.
    <MotionConfig reducedMotion="user">
      {/* Safe areas (--sai-*, index.css). The table pads its own sides and bottom: max(inset, its gap), not inset + gap. */}
      <div
        dir="rtl"
        className={`flex flex-col pt-[var(--sai-top)] text-text ${
          fitScreen ? 'h-dvh overflow-hidden' : 'min-h-dvh pr-[var(--sai-right)] pb-[var(--sai-bottom)] pl-[var(--sai-left)]'
        }`}
        data-fit-screen={fitScreen || undefined}
      >
        {/* The tutorial needs no game server: no "connecting…" banner there. */}
        {route.name !== 'tutorial' && <ConnectionBanner />}
        <main className="flex min-h-0 flex-1 flex-col" inert={reconnecting} aria-busy={reconnecting}><Screen route={route} lesson={lesson} /></main>
        <ErrorToast />
        <NoticeToast />
      </div>
    </MotionConfig>
  );
}
