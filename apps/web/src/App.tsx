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

/**
 * `settings` / `audio` / `vibrator` / `profiles` are injectable for tests (default: localStorage,
 * Web Audio, navigator.vibrate, the server's /api).
 */
export function App({
  settings,
  audio,
  vibrator,
  profiles,
}: { settings?: SettingsStore; audio?: AudioEngine; vibrator?: Vibrator; profiles?: Profiles } = {}) {
  return (
    <PrefsProvider {...(settings ? { settings } : {})} {...(audio ? { audio } : {})} {...(vibrator ? { vibrator } : {})}>
      <ProfilesProvider {...(profiles ? { profiles } : {})}>
        <AppShell />
      </ProfilesProvider>
    </PrefsProvider>
  );
}

function Screen({ route }: { route: ReturnType<typeof useRoute> }) {
  switch (route.name) {
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
  const fitScreen = roomId !== null && showsTable(state, roomId);

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
        <ConnectionBanner />
        <main className="flex min-h-0 flex-1 flex-col" inert={reconnecting} aria-busy={reconnecting}><Screen route={route} /></main>
        <ErrorToast />
        <NoticeToast />
      </div>
    </MotionConfig>
  );
}
