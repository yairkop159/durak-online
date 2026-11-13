import type { RoomStatePayload, SessionIssuedPayload } from '@durak/shared';
import { useState } from 'react';
import { Badge, Button, Panel } from '../components/ui';
import { t } from '../i18n';
import { useClient } from '../net/react';
import { navigate, roomUrl } from '../routing';

export function LobbyScreen({ room, session }: { room: RoomStatePayload; session: SessionIssuedPayload }) {
  const client = useClient();
  const isHost = room.hostId === session.playerId;
  const canStart = room.members.length >= 2;

  const leave = () => {
    client.leaveRoom();
    navigate('/');
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-4">
      <h1 className="text-center text-3xl font-black">{t.lobby.title}</h1>
      <InviteLink roomId={room.roomId} />
      <Panel className="flex flex-col gap-3">
        <h2 className="font-bold">{t.lobby.players(room.members.length, room.maxPlayers)}</h2>
        <ul className="flex flex-col gap-2">
          {room.members.map((m) => (
            <li key={m.playerId} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 rounded-full ${m.connected ? 'bg-lime-400' : 'bg-slate-500'}`}
              />
              <span className="flex-1 font-medium">
                {m.nickname}
                {m.playerId === session.playerId && <span className="text-emerald-100/60"> ({t.common.you})</span>}
              </span>
              {m.playerId === room.hostId && <Badge tone="amber">{t.lobby.host}</Badge>}
              {!m.connected && <Badge tone="gray">{t.lobby.offline}</Badge>}
              {m.afk && <Badge tone="red">{t.lobby.afk}</Badge>}
            </li>
          ))}
        </ul>
        {room.spectatorCount > 0 && <p className="text-sm text-emerald-100/70">{t.lobby.spectators(room.spectatorCount)}</p>}
      </Panel>

      {isHost ? (
        <Button onClick={() => client.startGame()} disabled={!canStart}>
          {canStart ? t.lobby.start : t.lobby.needMorePlayers}
        </Button>
      ) : (
        <p className="text-center text-emerald-100/80">{t.lobby.waitingForHost}</p>
      )}
      <Button variant="secondary" onClick={leave}>
        {t.lobby.leave}
      </Button>
    </div>
  );
}

function InviteLink({ roomId }: { roomId: string }) {
  const url = roomUrl(roomId);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is selectable in the field.
    }
  };
  return (
    <Panel className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t.lobby.invite}</span>
      <div className="flex gap-2">
        <input
          readOnly
          value={url}
          dir="ltr"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg bg-white/90 px-3 py-2 text-sm text-slate-900"
          aria-label={t.lobby.invite}
        />
        <Button onClick={() => void copy()}>{copied ? t.lobby.copied : t.lobby.copy}</Button>
      </div>
    </Panel>
  );
}
