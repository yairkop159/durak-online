import {
  TEAM_GAME_PLAYERS,
  TOURNAMENT_GAME_COUNTS,
  TOURNAMENT_MIN_HUMANS,
  teamOfSeat,
  type BotDifficulty,
  type RoomMember,
  type RoomStatePayload,
  type SessionIssuedPayload,
  type TeamIndex,
  type TournamentGameCount,
} from '@durak/shared';
import { useState } from 'react';
import { BotPill } from '../components/BotPill';
import { DifficultyPicker } from '../components/DifficultyPicker';
import { TeamsSwitch } from '../components/TeamsSwitch';
import { Avatar, Button, Panel, Pill } from '../components/ui';
import { displayName } from '../game/seats';
import { TEAM_DOT, TEAM_RING, TEAM_TEXT, teamName } from '../game/teams';
import { t } from '../i18n';
import { useClient } from '../net/react';
import { ReactionAnnouncer, ReactionBubble } from '../reactions/ReactionBubble';
import { ReactionButton } from '../reactions/ReactionPicker';
import { useReactions, type ReactionsInView } from '../reactions/useReactions';
import { navigate, roomUrl } from '../routing';

export function LobbyScreen({ room, session }: { room: RoomStatePayload; session: SessionIssuedPayload }) {
  const client = useClient();
  const isHost = room.hostId === session.playerId;
  const teams = room.config.teams;
  const series = room.tournamentSetup;
  const humans = room.members.filter((m) => !m.isBot && !m.leftGame).length;
  const enoughHumans = !series || humans >= TOURNAMENT_MIN_HUMANS;
  const canStart = (teams ? room.members.length === TEAM_GAME_PLAYERS : room.members.length >= 2) && enoughHumans;
  // The host's last pick, kept while the switch is off.
  const [games, setGames] = useState<TournamentGameCount>(series?.games ?? 3);
  const [difficulty, setDifficulty] = useState<BotDifficulty>('medium');
  // Host seat swap (team mode): the first tapped member, waiting for the second.
  const [picked, setPicked] = useState<string | null>(null);
  const reactions = useReactions();
  const seated = room.members.some((m) => m.playerId === session.playerId && !m.isBot);
  const pickedStillHere = picked !== null && room.members.some((m) => m.playerId === picked) ? picked : null;

  const leave = () => {
    client.leaveRoom();
    navigate('/');
  };

  const swapTap = (playerId: string) => {
    if (pickedStillHere === null) setPicked(playerId);
    else if (pickedStillHere === playerId) setPicked(null);
    else {
      client.swapSeats(pickedStillHere, playerId);
      setPicked(null);
    }
  };

  const row = (m: RoomMember, seat: number) => (
    <MemberRow
      key={m.playerId}
      member={m}
      team={teams ? teamOfSeat(seat) : null}
      isMe={m.playerId === session.playerId}
      isHostMember={m.playerId === room.hostId}
      canRemove={isHost && m.isBot}
      onRemove={() => client.removeBot(m.playerId)}
      swap={isHost && teams ? { picked: pickedStillHere === m.playerId, anyPicked: pickedStillHere !== null, onTap: () => swapTap(m.playerId) } : null}
      reactions={reactions}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-4">
      <h1 className="text-center text-3xl font-black">{t.lobby.title}</h1>
      <InviteLink roomId={room.roomId} />
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-bold">{t.lobby.players(room.members.length, room.maxPlayers)}</h2>
          <p className="text-xs text-muted" data-testid="lobby-mode">
            {t.home.modes[room.config.mode]}
            {teams && ` · ${t.teams.modeLine}`}
            {series && ` · ${t.tournament.lobbyLine(series.games)}`}
          </p>
        </div>

        {isHost && (
          <div className="flex flex-col gap-2" data-testid="lobby-tournament">
            <TeamsSwitch
              checked={series !== null}
              onChange={(on) => client.setTournament(on ? games : null)}
              label={`🏆 ${t.tournament.toggle}`}
              hint={t.tournament.toggleHint}
              testId="tournament-switch"
            />
            {series && (
              <div role="radiogroup" aria-label={t.tournament.games} className="grid grid-cols-3 gap-1.5" data-testid="tournament-games">
                {TOURNAMENT_GAME_COUNTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={series.games === n}
                    onClick={() => {
                      setGames(n);
                      client.setTournament(n);
                    }}
                    className={`min-h-11 rounded-btn py-1.5 text-sm font-bold ring-1 transition-colors ${
                      series.games === n ? 'bg-accent text-accent-ink ring-accent' : 'bg-surface-2 ring-line hover:bg-surface-3'
                    }`}
                  >
                    {t.tournament.gamesOption(n)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isHost && room.maxPlayers === TEAM_GAME_PLAYERS && (
          <TeamsSwitch checked={teams} onChange={(on) => client.setTeams(on)} />
        )}

        {teams ? (
          <div className="flex flex-col gap-3" data-testid="lobby-teams">
            {([0, 1] as const).map((team) => (
              <section key={team} aria-labelledby={`team-${team}-title`} className="flex flex-col gap-1.5">
                <h3 id={`team-${team}-title`} className={`flex items-center gap-1.5 text-sm font-bold ${TEAM_TEXT[team]}`}>
                  <span aria-hidden="true" className={`size-2.5 rounded-full ${TEAM_DOT[team]}`} />
                  {teamName(team)}
                </h3>
                <ul className="flex flex-col gap-2">
                  {[team, team + 2].map((seat) => {
                    const m = room.members[seat];
                    return m ? (
                      row(m, seat)
                    ) : (
                      <li
                        key={`empty-${seat}`}
                        className={`flex min-h-11 items-center rounded-btn border border-dashed border-line-strong px-3 py-2 text-sm text-muted`}
                      >
                        {t.teams.emptySeat}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {isHost && room.members.length > 1 && <p className="text-xs text-muted">{t.teams.swapHint}</p>}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">{room.members.map((m, seat) => row(m, seat))}</ul>
        )}

        {room.spectatorCount > 0 && <p className="text-sm text-muted">{t.lobby.spectators(room.spectatorCount)}</p>}
        {seated && reactions.enabled && (
          <div className="flex justify-center">
            <ReactionButton placement="down" />
          </div>
        )}
        <ReactionAnnouncer latest={reactions.latest} nameOf={(id) => {
          const m = room.members.find((x) => x.playerId === id);
          return m ? displayName(m) : '';
        }} />
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
          {canStart
            ? t.lobby.start
            : !enoughHumans
              ? t.tournament.needHumans
              : teams
                ? t.teams.needFour
                : t.lobby.needMorePlayers}
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

function MemberRow({
  member: m,
  team,
  isMe,
  isHostMember,
  canRemove,
  onRemove,
  swap,
  reactions,
}: {
  member: RoomMember;
  /** The seat's team in a team room, else null. */
  team: TeamIndex | null;
  isMe: boolean;
  isHostMember: boolean;
  canRemove: boolean;
  onRemove: () => void;
  /** The host's swap control (team rooms only). */
  swap: { picked: boolean; anyPicked: boolean; onTap: () => void } | null;
  reactions: ReactionsInView;
}) {
  const name = displayName(m);
  const reaction = reactions.byPlayer.get(m.playerId);
  const ring = team !== null ? `ring-2 ${TEAM_RING[team]}` : 'ring-1 ring-line';
  return (
    <li
      data-testid={`member-${m.playerId}`}
      data-team={team ?? undefined}
      className={`flex items-center gap-2 rounded-btn px-3 py-2 ${swap?.picked ? 'bg-select/15' : 'bg-surface-2/70'} ${ring}`}
    >
      <span className="relative">
        <Avatar id={m.playerId} name={m.isBot ? '🤖' : name} size={30} dim={!m.connected} />
        {!m.isBot && (
          <span
            aria-hidden="true"
            className={`absolute right-0.5 bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-2 ${m.connected ? 'bg-accent' : 'bg-muted'}`}
          />
        )}
        {reaction && <ReactionBubble key={reaction.id} reaction={reaction} />}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {name}
        {isMe && <span className="text-muted"> ({t.common.you})</span>}
      </span>
      {m.isBot && <BotPill member={m} />}
      {isHostMember && <Pill tone="accent">{t.lobby.host}</Pill>}
      {!m.isBot && !m.connected && <Pill tone="muted">{t.lobby.offline}</Pill>}
      {!m.isBot && m.afk && <Pill tone="warn">{t.lobby.afk}</Pill>}
      {swap && (
        <button
          type="button"
          onClick={swap.onTap}
          aria-pressed={swap.picked}
          aria-label={swap.anyPicked && !swap.picked ? t.teams.swapWith(name) : t.teams.swapPick(name)}
          title={swap.anyPicked && !swap.picked ? t.teams.swapWith(name) : t.teams.swapPick(name)}
          data-testid={`swap-${m.playerId}`}
          className={`grid size-11 shrink-0 place-items-center rounded-full ring-1 transition-colors ${
            swap.picked ? 'bg-select text-white ring-select' : 'text-muted ring-line hover:bg-surface-3'
          }`}
        >
          ⇅
        </button>
      )}
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t.bots.remove(name)}
          title={t.bots.remove(name)}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted ring-1 ring-line transition-colors hover:bg-danger/15 hover:text-danger"
        >
          ✕
        </button>
      )}
    </li>
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
