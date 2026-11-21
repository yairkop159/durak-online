import type { RoomStatePayload, SessionIssuedPayload } from '@durak/shared';
import { Button, Panel } from '../components/ui';
import { nicknameOf } from '../game/seats';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';
import { navigate } from '../routing';
import { LeaveButton } from '../screens/table/TopBar';
import { tournamentLeave } from './tournament';
import { TournamentActions, TournamentSummary } from './TournamentPanel';

/**
 * A series room between games whose finished game is no longer held (it expired, or a reload
 * found only the room): the standings and the same actions as on the game-over screen.
 */
export function TournamentScreen({ room, session }: { room: RoomStatePayload; session: SessionIssuedPayload }) {
  const client = useClient();
  const { roomReceivedAt } = useClientState();
  const tv = room.tournament!;
  const nameOf = (id: string) => nicknameOf(id, room.members);
  const seated = room.members.some((m) => m.playerId === session.playerId);
  const viewerId = seated ? session.playerId : null;
  const leaveKind = tournamentLeave(room, viewerId);
  const leave = () => {
    client.leaveRoom();
    navigate('/');
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-safe-4" data-testid="tournament-screen">
      <Panel className="flex flex-col items-center gap-4 text-center">
        <TournamentSummary tournament={tv} nameOf={nameOf} viewerId={viewerId} />
        {tv.status === 'running' ? (
          <TournamentActions
            room={room}
            viewerId={viewerId}
            roomReceivedAt={roomReceivedAt}
            now={client.now}
            nameOf={nameOf}
            onNext={() => client.tournamentNext()}
            onEnd={() => client.tournamentEnd()}
            {...(seated
              ? {
                  leave: (
                    <LeaveButton
                      outcome="none"
                      onLeave={leave}
                      extra={leaveKind === 'bot' ? t.tournament.leaveBot : leaveKind === 'ends' ? t.tournament.leaveEnds : null}
                    />
                  ),
                }
              : {})}
          />
        ) : seated ? (
          <Button size="lg" className="w-full" onClick={() => client.rematch()}>
            {t.tournament.backToLobby}
          </Button>
        ) : (
          <Button variant="secondary" className="w-full" onClick={() => navigate('/')}>
            {t.common.backHome}
          </Button>
        )}
      </Panel>
    </div>
  );
}
