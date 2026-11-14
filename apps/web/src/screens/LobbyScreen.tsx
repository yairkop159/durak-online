import type { BotDifficulty, RoomStatePayload, SessionIssuedPayload } from '@durak/shared';
import { useState } from 'react';
import { BotPill } from '../components/BotPill';
import { DifficultyPicker } from '../components/DifficultyPicker';
import { Avatar, Button, Panel, Pill } from '../components/ui';
import { displayName } from '../game/seats';
import { t } from '../i18n';
import { useClient } from '../net/react';
import { navigate, roomUrl } from '../routing';

export function LobbyScreen({ room, session }: { room: RoomStatePayload; session: SessionIssuedPayload }) {
  const client = useClient();
  const isHost = room.hostId === session.playerId;
  const canStart = room.members.length >= 2;
  const [difficulty, setDifficulty] = useState<BotDifficulty>('medium');

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
          {room.members.map((m) => {
            const name = displayName(m);
            return (
              <li
                key={m.playerId}
                data-testid={`member-${m.playerId}`}
                className="flex items-center gap-2 rounded-btn bg-surface-2/70 px-3 py-2 ring-1 ring-line"
              >
                <span className="relative">
                  <Avatar id={m.playerId} name={m.isBot ? '🤖' : name} size={30} dim={!m.connected} />
                  {!m.isBot && (
                    <span
                      aria-hidden="true"
                      className={`absolute right-0.5 bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-2 ${m.connected ? 'bg-accent' : 'bg-muted'}`}
                    />
                  )}
                </span>
                <span className="flex-1 font-medium">
                  {name}
                  {m.playerId === session.playerId && <span className="text-muted"> ({t.common.you})</span>}
                </span>
                {m.isBot && <BotPill member={m} />}
                {m.playerId === room.hostId && <Pill tone="accent">{t.lobby.host}</Pill>}
                {!m.isBot && !m.connected && <Pill tone="muted">{t.lobby.offline}</Pill>}
                {!m.isBot && m.afk && <Pill tone="warn">{t.lobby.afk}</Pill>}
                {isHost && m.isBot && (
                  <button
                    type="button"
                    onClick={() => client.removeBot(m.playerId)}
                    aria-label={t.bots.remove(name)}
                    title={t.bots.remove(name)}
                    className="grid size-7 place-items-center rounded-full text-muted ring-1 ring-line transition-colors hover:bg-danger/15 hover:text-danger"
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {room.spectatorCount > 0 && <p className="text-sm text-muted">{t.lobby.spectators(room.spectatorCount)}</p>}
        {isHost && room.members.length < room.maxPlayers && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <span className="text-sm font-semibold">🤖 {t.bots.addTitle}</span>
            <span className="text-xs text-muted" data-testid="add-bot-hint">
              {t.bots.addHint}
            </span>
            <span className="mt-1 text-sm font-medium">{t.bots.difficulty}</span>
            <DifficultyPicker value={difficulty} onChange={setDifficulty} />
            <Button variant="secondary" onClick={() => client.addBot(difficulty)}>
              🤖 {t.bots.add}
            </Button>
          </div>
        )}
      </Panel>

      {isHost ? (
        <Button onClick={() => client.startGame()} disabled={!canStart}>
          {canStart ? t.lobby.start : t.lobby.needMorePlayers}
        </Button>
      ) : (
        <p className="text-center text-muted">{t.lobby.waitingForHost}</p>
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
          className="min-w-0 flex-1 rounded-btn bg-bg-0/70 px-3 py-2 text-sm text-text ring-1 ring-line-strong"
          aria-label={t.lobby.invite}
        />
        <Button onClick={() => void copy()}>{copied ? t.lobby.copied : t.lobby.copy}</Button>
      </div>
    </Panel>
  );
}
