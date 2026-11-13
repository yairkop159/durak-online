import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { ConnectionBanner, ErrorToast } from './components/ui';
import { useClient, useClientState } from './net/react';
import { isReconnecting } from './net/store';
import { useRoute } from './routing';
import { HomeScreen } from './screens/HomeScreen';
import { RoomRoute } from './screens/RoomRoute';

export function App() {
  const client = useClient();
  const route = useRoute();
  const roomId = route.name === 'room' ? route.roomId : null;
  // While the seat is being re-bound nothing in the room may be clicked (the banner says why).
  const reconnecting = isReconnecting(useClientState());

  useEffect(() => {
    client.setRoute(roomId);
  }, [client, roomId]);

  return (
    // reducedMotion="user": with prefers-reduced-motion, Framer skips transform/layout animations.
    <MotionConfig reducedMotion="user">
      <div dir="rtl" className="flex min-h-dvh flex-col text-text">
        <ConnectionBanner />
        <main className="flex flex-1 flex-col" inert={reconnecting} aria-busy={reconnecting}>{roomId === null ? <HomeScreen /> : <RoomRoute roomId={roomId} />}</main>
        <ErrorToast />
      </div>
    </MotionConfig>
  );
}
