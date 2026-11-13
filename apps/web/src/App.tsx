import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { ConnectionBanner, ErrorToast } from './components/ui';
import { useClient } from './net/react';
import { useRoute } from './routing';
import { HomeScreen } from './screens/HomeScreen';
import { RoomRoute } from './screens/RoomRoute';

export function App() {
  const client = useClient();
  const route = useRoute();
  const roomId = route.name === 'room' ? route.roomId : null;

  useEffect(() => {
    client.setRoute(roomId);
  }, [client, roomId]);

  return (
    // reducedMotion="user": with prefers-reduced-motion, Framer skips transform/layout animations.
    <MotionConfig reducedMotion="user">
      <div dir="rtl" className="flex min-h-dvh flex-col text-text">
        <ConnectionBanner />
        <main className="flex flex-1 flex-col">{roomId === null ? <HomeScreen /> : <RoomRoute roomId={roomId} />}</main>
        <ErrorToast />
      </div>
    </MotionConfig>
  );
}
