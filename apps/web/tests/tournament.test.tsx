import type { GameOverPayload, PlayerView, RoomStatePayload, StandingRow, TournamentView } from '@durak/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { championLine } from '../src/tournament/TournamentPanel';
import { canLead, formatPoints, gamesLeft, tournamentLeave } from '../src/tournament/tournament';
import { FakeTransport, gameState, makeView, renderTable, ROOM_ID, roomState } from './helpers';

const TOKEN = 'x'.repeat(43);

const row = (key: string, points: number, rank: number, over: Partial<StandingRow> = {}): StandingRow => ({
  key,
  playerIds: [key],
  points,
  duraks: 0,
  firsts: 0,
  lastPoints: 1,
  eligible: true,
  rank,
  ...over,
});

function series(over: Partial<TournamentView> = {}): TournamentView {
  return {
    id: 't1',
    status: 'running',
    teams: false,
    gamesPlanned: 5,
    gamesPlayed: 2,
    roster: ['me', 'bob', 'carl'].map((id) => ({ playerId: id, nickname: id.toUpperCase(), isBot: false, left: false })),
    standings: [row('bob', 3.5, 1), row('me', 2, 2), row('carl', 0.5, 3)],
    champions: [],
    leadOpenAt: null,
    serverTime: 1_000,
    ...over,
  };
}

function seriesRoom(status: RoomStatePayload['status'], tv: TournamentView | null, hostId = 'me'): RoomStatePayload {
  return { ...roomState(status, ['me', 'bob', 'carl']), hostId, tournamentSetup: { games: 5 }, tournament: tv };
}

const finishedView = (viewer: string | null = 'me'): PlayerView =>
  makeView({ viewer, phase: { kind: 'finished', durak: 'carl' }, finished: ['bob', 'me'], counts: { me: 0, bob: 0, carl: 3 } });

const over: GameOverPayload = { roomId: ROOM_ID, durakId: 'carl', finishOrder: ['bob', 'me'], endReason: 'normal', botAssisted: [], forfeits: [], stats: {} };

/** The game-over screen of a series game. */
function betweenGames(tv: TournamentView, options: { viewer?: string | null; hostId?: string } = {}) {
  const ctx = renderTable(finishedView(options.viewer === undefined ? 'me' : options.viewer));
  act(() => {
    ctx.transport.serverSends('room:state', seriesRoom('finished', tv, options.hostId));
    ctx.transport.serverSends('game:over', over);
  });
  return ctx;
}

function lobbyAs(playerId: string, room: RoomStatePayload) {
  window.history.replaceState(null, '', `/room/${ROOM_ID}`);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage(), now: () => 1_000 });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => {
    transport.connect();
    transport.serverSends('session:issued', { sessionToken: TOKEN, playerId, roomId: ROOM_ID });
    transport.serverSends('room:state', room);
  });
  return { transport, client };
}

describe('tournament helpers (client)', () => {
  it('points, games left, and who may lead between games', () => {
    expect(formatPoints(2)).toBe('2');
    expect(formatPoints(2.5)).toBe('2.5');
    expect(gamesLeft(series())).toBe(3);
    const room = seriesRoom('finished', series());
    expect(canLead(room, 'me', 1_000)).toBe(true); // the host
    expect(canLead(room, 'bob', 1_000)).toBe(false);
    const away = seriesRoom('finished', series({ leadOpenAt: 5_000 }));
    expect(canLead(away, 'bob', 4_999)).toBe(false);
    expect(canLead(away, 'bob', 5_000)).toBe(true);
    expect(canLead(seriesRoom('playing', series({ leadOpenAt: 0 })), 'bob', 9_999)).toBe(false);
    expect(canLead(away, null, 9_999)).toBe(false); // spectators never
  });

  it('leaving: a bot plays my seat, or the series ends when fewer than two humans would remain', () => {
    expect(tournamentLeave(seriesRoom('finished', series()), 'me')).toBe('bot');
    const two = series({ roster: series().roster.map((s) => (s.playerId === 'carl' ? { ...s, left: true } : s)) });
    expect(tournamentLeave(seriesRoom('finished', two), 'me')).toBe('ends');
    expect(tournamentLeave(seriesRoom('finished', series({ status: 'finished' })), 'me')).toBeNull();
    expect(tournamentLeave(seriesRoom('finished', series()), null)).toBeNull();
  });

  it('the champion line: me, someone, a bot, co-champions, a team, an early end', () => {
    const nameOf = (id: string) => id.toUpperCase();
    const done = (champions: string[], extra: Partial<TournamentView> = {}) => series({ status: 'finished', champions, ...extra });
    expect(championLine(done(['me']), nameOf, 'me')).toBe(t.tournament.youChampion);
    expect(championLine(done(['bob']), nameOf, 'me')).toBe(t.tournament.champion('BOB'));
    expect(championLine(done(['me', 'bob']), nameOf, 'me')).toBe(t.tournament.coChampions('BOB, ME'));
    const bot = done(['bob'], { roster: series().roster.map((s) => (s.playerId === 'bob' ? { ...s, isBot: true } : s)) });
    expect(championLine(bot, nameOf, 'me')).toBe(t.tournament.botChampion('BOB'));
    const teams = done(['team1'], { teams: true, standings: [row('team1', 2, 1, { playerIds: ['b', 'd'] }), row('team0', 1, 2, { playerIds: ['a', 'c'] })] });
    expect(championLine(teams, nameOf, 'a')).toBe(t.tournament.teamChampion(t.teams.names[1]));
    expect(championLine(series({ status: 'endedEarly' }), nameOf, 'me')).toBe(t.tournament.endedEarly);
  });
});

describe('lobby: the host sets up a series', () => {
  it('the switch turns it on with 3 games; the picker changes it; others see the setting', async () => {
    const lobby = { ...roomState('lobby', ['me', 'bob']), maxPlayers: 3 };
    const { transport } = lobbyAs('me', lobby);
    await userEvent.click(screen.getByTestId('tournament-switch'));
    expect(transport.emittedOf('room:setTournament')).toEqual([{ roomId: ROOM_ID, games: 3 }]);

    act(() => transport.serverSends('room:state', { ...lobby, tournamentSetup: { games: 3 } }));
    expect(screen.getByTestId('tournament-switch')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: t.tournament.gamesOption(7) }));
    expect(transport.emittedOf('room:setTournament').at(-1)).toEqual({ roomId: ROOM_ID, games: 7 });
    expect(screen.getByTestId('lobby-mode')).toHaveTextContent(t.tournament.lobbyLine(3));

    await userEvent.click(screen.getByTestId('tournament-switch'));
    expect(transport.emittedOf('room:setTournament').at(-1)).toEqual({ roomId: ROOM_ID, games: null });
  });

  it('a guest sees the setting but no controls; one human with a bot cannot start a series', () => {
    lobbyAs('bob', { ...roomState('lobby', ['me', 'bob']), tournamentSetup: { games: 5 } });
    expect(screen.queryByTestId('tournament-switch')).toBeNull();
    expect(screen.getByTestId('lobby-mode')).toHaveTextContent(t.tournament.lobbyLine(5));
  });

  it('start is disabled with fewer than two humans', () => {
    const lobby = roomState('lobby', ['me', 'bot1']);
    const withBot: RoomStatePayload = {
      ...lobby,
      tournamentSetup: { games: 3 },
      members: lobby.members.map((m) => (m.playerId === 'bot1' ? { ...m, isBot: true, botDifficulty: 'easy' } : m)),
    };
    lobbyAs('me', withBot);
    expect(screen.getByRole('button', { name: t.tournament.needHumans })).toBeDisabled();
  });
});

describe('between games: standings and the lead actions', () => {
  it('shows the table (leader, games left, +points); the host starts the next game or ends it', async () => {
    const { transport } = betweenGames(series());
    const summary = screen.getByTestId('tournament-summary');
    expect(within(summary).getByTestId('tournament-leader')).toHaveTextContent(t.tournament.leader('BOB'));
    expect(within(summary).getByTestId('tournament-progress')).toHaveTextContent(t.tournament.gamesLeft(3));
    expect(within(screen.getByTestId('standing-bob')).getByText('3.5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.gameOver.backToLobby })).toBeNull();

    await userEvent.click(screen.getByTestId('tournament-next'));
    expect(transport.emittedOf('tournament:next')).toEqual([{ roomId: ROOM_ID }]);

    await userEvent.click(screen.getByTestId('tournament-end'));
    expect(screen.getByTestId('confirm-body')).toHaveTextContent(t.tournament.endConfirm.body);
    await userEvent.click(screen.getByRole('button', { name: t.tournament.endConfirm.confirm }));
    expect(transport.emittedOf('tournament:end')).toEqual([{ roomId: ROOM_ID }]);
  });

  it('leaving between games always asks, and says a bot will play the seat', async () => {
    const { transport } = betweenGames(series());
    await userEvent.click(within(screen.getByTestId('tournament-actions')).getByTestId('leave-button'));
    expect(screen.getByTestId('confirm-body')).toHaveTextContent(t.tournament.leaveBot);
    expect(transport.emittedOf('room:leave')).toEqual([]);
  });

  it('a guest waits for the host; once the host is away long enough, the guest may lead', () => {
    betweenGames(series({ leadOpenAt: 31_000 }), { viewer: 'bob' });
    expect(screen.getByTestId('tournament-waiting')).toHaveTextContent(t.tournament.hostAwayIn(30));
    expect(screen.queryByTestId('tournament-next')).toBeNull();
  });

  it('a guest whose host is already away gets the buttons and the reason', () => {
    betweenGames(series({ leadOpenAt: 0 }), { viewer: 'bob' });
    expect(screen.getByTestId('tournament-next')).toBeInTheDocument();
    expect(screen.getByText(t.tournament.hostAway)).toBeInTheDocument();
  });

  it('a spectator sees the same table and no buttons', () => {
    betweenGames(series(), { viewer: null });
    expect(screen.getByTestId('tournament-standings')).toBeInTheDocument();
    expect(screen.queryByTestId('tournament-next')).toBeNull();
    expect(within(screen.getByTestId('tournament-actions')).queryByTestId('leave-button')).toBeNull();
  });

  it('after the last game: the champion, the final table, and back to the lobby', async () => {
    const { transport } = betweenGames(series({ status: 'finished', gamesPlayed: 5, champions: ['bob'] }));
    expect(screen.getByTestId('tournament-result')).toHaveTextContent(t.tournament.champion('BOB'));
    expect(screen.getByTestId('standing-bob')).toHaveTextContent('🏆');
    await userEvent.click(screen.getByRole('button', { name: t.gameOver.backToLobby }));
    expect(transport.emittedOf('room:rematch')).toEqual([{ roomId: ROOM_ID }]);
  });
});

describe('during a series game', () => {
  it('the top bar shows the game number, and leaving says what happens to the series', async () => {
    const view = makeView({ counts: { me: 6, bob: 6, carl: 6 } });
    const ctx = renderTable(view);
    act(() => ctx.transport.serverSends('room:state', seriesRoom('playing', series())));
    expect(screen.getByTestId('tournament-pill')).toHaveAccessibleName(t.tournament.gamePill(3, 5));
    await userEvent.click(screen.getAllByTestId('leave-button')[0]!);
    expect(screen.getByTestId('confirm-body')).toHaveTextContent(t.tournament.leaveBot);
  });
});

describe('a reload between games whose finished game is gone', () => {
  it('shows the standings screen with the same actions', async () => {
    const { transport } = lobbyAs('me', seriesRoom('finished', series()));
    expect(screen.getByTestId('tournament-screen')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tournament-next'));
    expect(transport.emittedOf('tournament:next')).toEqual([{ roomId: ROOM_ID }]);
    // The next game arrives: the table replaces the screen.
    act(() => {
      transport.serverSends('room:state', seriesRoom('playing', series()));
      transport.serverSends('game:state', gameState(makeView({ counts: { me: 6, bob: 6, carl: 6 } }), 0, { gameId: 'g2' }));
    });
    expect(screen.queryByTestId('tournament-screen')).toBeNull();
  });
});
