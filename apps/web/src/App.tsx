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

/** `settings` / `audio` / `vibrator` are injectable for tests (default: localStorage, Web Audio, navigator.vibrate). */
export function App({ settings, audio, vibrator }: { settings?: SettingsStore; audio?: AudioEngine; vibrator?: Vibrator } = {}) {
  return (
    <PrefsProvider {...(settings ? { settings } : {})} {...(audio ? { audio } : {})} {...(vibrator ? { vibrator } : {})}>
      <AppShell />
    </PrefsProvider>
  );
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
      {/* Safe areas (notch, rounded corners, home bar; needs viewport-fit=cover): the table's bottom row pads itself. */}
      <div
        dir="rtl"
        className={`flex flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-text ${
          fitScreen ? 'h-dvh overflow-hidden' : 'min-h-dvh pb-[env(safe-area-inset-bottom)]'
        }`}
        data-fit-screen={fitScreen || undefined}
      >
        <ConnectionBanner />
        <main className="flex min-h-0 flex-1 flex-col" inert={reconnecting} aria-busy={reconnecting}>{roomId !== null ? <RoomRoute roomId={roomId} /> : route.name === 'rules' ? <RulesScreen /> : <HomeScreen />}</main>
        <ErrorToast />
        <NoticeToast />
      </div>
    </MotionConfig>
  );
}
