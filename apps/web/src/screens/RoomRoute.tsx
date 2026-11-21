import { Button, Panel } from '../components/ui';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';
import { navigate } from '../routing';
import type { ClientState } from '../net/store';
import { JoinPrompt } from './JoinPrompt';
import { LobbyScreen } from './LobbyScreen';
import { OnlineTable } from './OnlineTable';
import { TournamentScreen } from '../tournament/TournamentScreen';

/** True when `/room/:roomId` shows the game table (the same choice RoomRoute makes). */
export function showsTable(state: ClientState, roomId: string): boolean {
  const { session, room, game, roomNotFound } = state;
  return !roomNotFound && session?.roomId === roomId && room?.roomId === roomId && room.status !== 'lobby' && game?.roomId === roomId;
}

/** `/room/:id`: picks the screen from the session, the resume status and the room status. */
export function RoomRoute({ roomId }: { roomId: string }) {
  const client = useClient();
  const { session, room, game, roomNotFound } = useClientState();

  if (roomNotFound) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-4">
        <Panel className="flex flex-col gap-4 text-center">
          <h1 className="text-2xl font-bold">{t.notFound.title}</h1>
          <p className="text-muted">{t.notFound.body}</p>
          <Button onClick={() => navigate('/')}>{t.common.backHome}</Button>
        </Panel>
      </div>
    );
  }

  if (session?.roomId !== roomId) {
    // A stored token is resumed automatically on connect (a rejected one is deleted).
    return client.hasStoredSession(roomId) ? <Loading /> : <JoinPrompt roomId={roomId} />;
  }
  if (!room || room.roomId !== roomId) return <Loading />;

  if (room.status === 'lobby') return <LobbyScreen room={room} session={session} />;
  if (!game || game.roomId !== roomId) {
    // A series between games whose finished game is gone (expired; the room lives on): its table.
    return room.status === 'finished' && room.tournament ? <TournamentScreen room={room} session={session} /> : <Loading />;
  }
  return <OnlineTable />;
}

function Loading() {
  return <div className="flex flex-1 items-center justify-center text-muted">{t.common.loading}</div>;
}
