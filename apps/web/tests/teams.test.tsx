import type { GameOverPayload, PlayerView, RoomStatePayload } from '@durak/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { gameOverCue } from '../src/audio/soundPlan';
import { myPartner, teamName, viewerResult } from '../src/game/teams';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { FakeTransport, makeView, renderTable, ROOM_ID, roomState } from './helpers';

const TOKEN = 'x'.repeat(43);
// Seats: me (0, team 0), b (1, team 1), c (2, team 0: my partner), d (3, team 1).
const COUNTS = { me: 5, b: 4, c: 6, d: 3 };
const teamView = (spec: Parameters<typeof makeView>[0] = {}) => makeView({ counts: COUNTS, ...spec, config: { teams: true, ...spec.config } });

function gameOver(durakId: string | null, endReason: GameOverPayload['endReason'] = 'normal'): GameOverPayload {
  return { roomId: ROOM_ID, durakId, finishOrder: ['b'], endReason, botAssisted: [], forfeits: endReason === 'forfeit' && durakId ? [durakId] : [], stats: {} };
}

function finished(durak: string | null, viewer: string | null = 'me'): PlayerView {
  return teamView({ viewer, phase: { kind: 'finished', durak }, finished: ['b'], counts: { me: 2, b: 0, c: 1, d: 4 } });
}

function showGameOver(view: PlayerView, over: GameOverPayload | null) {
  const ctx = renderTable(view);
  act(() => {
    ctx.transport.serverSends('room:state', roomState('finished', view.players.map((p) => p.id)));
    if (over) ctx.transport.serverSends('game:over', over);
  });
  return ctx;
}

describe('team helpers (client)', () => {
  it('my partner sits opposite; the result is the team result', () => {
    const view = teamView();
    expect(myPartner(view)).toBe('c');
    expect(myPartner({ ...view, viewerId: null })).toBeNull();
    expect(myPartner(makeView({ counts: COUNTS }))).toBeNull();
    expect(viewerResult(view, 'c')).toBe('lost'); // my partner is the durak: we lost
    expect(viewerResult(view, 'me')).toBe('lost');
    expect(viewerResult(view, 'd')).toBe('won');
    expect(viewerResult(view, null)).toBeNull();
    expect(viewerResult({ ...view, viewerId: null }, 'd')).toBeNull();
    // Outside team mode only the durak lost.
    expect(viewerResult(makeView({ counts: COUNTS }), 'c')).toBe('won');
  });

  it("the durak stinger plays for the durak's partner too", () => {
    const view = teamView();
    expect(gameOverCue(gameOver('c'), 'me', view)).toBe('durak');
    expect(gameOverCue(gameOver('d'), 'me', view)).toBe('win');
    expect(gameOverCue(gameOver('c'), 'me')).toBe('win'); // no table: the classic rule
    expect(gameOverCue(gameOver('c'), null, view)).toBeNull();
  });
});

describe('team seats on the table', () => {
  it('every seat shows its team; only my partner carries the partner pill', () => {
    renderTable(teamView({ hand: '7S 8S 9S 10S JS' }));
    expect(screen.getByTestId('team-me')).toHaveAttribute('data-team', '0');
    expect(screen.getByTestId('team-c')).toHaveAttribute('data-team', '0');
    expect(screen.getByTestId('team-b')).toHaveAttribute('data-team', '1');
    expect(screen.getByTestId('team-d')).toHaveAttribute('data-team', '1');
    expect(within(screen.getByTestId('team-b')).getByText(teamName(1))).toBeInTheDocument(); // not colour alone
    expect(within(screen.getByTestId('seat-c')).getByText(t.teams.partner)).toBeInTheDocument();
    expect(screen.queryByTestId('partner-b')).toBeNull();
    expect(screen.queryByTestId('partner-d')).toBeNull();
    // The partner sits in the middle of the opponents (opposite me).
    const order = ['b', 'c', 'd'].map((id) => screen.getByTestId(`seat-${id}`));
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a spectator sees the team colours but no partner pill', () => {
    renderTable(teamView({ viewer: null }));
    expect(screen.getByTestId('team-c')).toHaveAttribute('data-team', '0');
    expect(screen.queryByText(t.teams.partner)).toBeNull();
  });

  it('a classic game shows no team marks', () => {
    renderTable(makeView({ counts: COUNTS }));
    expect(screen.queryByTestId('team-c')).toBeNull();
    expect(screen.queryByText(t.teams.partner)).toBeNull();
  });
});

describe('team game over', () => {
  it('my team won: the headline says so, and names the losing team and the durak', () => {
    showGameOver(finished('d'), gameOver('d'));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamWon);
    const line = screen.getByTestId('game-over-durak');
    expect(line).toHaveTextContent(teamName(1));
    expect(line).toHaveTextContent(t.gameOver.durak('D'));
  });

  it("my partner is the durak: my team lost (I am not the durak)", () => {
    showGameOver(finished('c'), gameOver('c'));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamLost);
    expect(screen.getByTestId('game-over-durak')).toHaveTextContent(t.gameOver.durak('C'));
  });

  it('I am the durak', () => {
    showGameOver(finished('me'), gameOver('me'));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamLost);
    expect(screen.getByTestId('game-over-durak')).toHaveTextContent(t.gameOver.youAreDurak);
  });

  it('a spectator reads which team lost', () => {
    showGameOver(finished('b', null), gameOver('b'));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamLostNamed(teamName(1)));
  });

  it('a forfeit names the leaver on the durak line', () => {
    showGameOver(finished('d'), gameOver('d', 'forfeit'));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamWon);
    expect(screen.getByTestId('game-over-durak')).toHaveTextContent(t.gameOver.forfeit('D'));
  });

  it('a draw stays a draw', () => {
    showGameOver(finished(null), gameOver(null));
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.gameOver.draw);
    expect(screen.queryByTestId('game-over-durak')).toBeNull();
  });

  it('after a reload (no game:over) the team result comes from the view alone', () => {
    showGameOver(finished('c'), null);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.teams.teamLost);
  });
});

// ---------------------------------------------------------------- lobby and Home

function setup(path: string) {
  window.history.replaceState(null, '', path);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage() });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => transport.connect());
  return { transport, client };
}

function lobby(playerId: string, room: RoomStatePayload) {
  const ctx = setup(`/room/${ROOM_ID}`);
  act(() => {
    ctx.transport.serverSends('session:issued', { sessionToken: TOKEN, playerId, roomId: ROOM_ID });
    ctx.transport.serverSends('room:state', room);
  });
  return ctx;
}

const teamRoom = (ids: string[], teams = true): RoomStatePayload => ({
  ...roomState('lobby', ids),
  maxPlayers: 4,
  config: { mode: 'podkidnoy', teams },
});

describe('team lobby', () => {
  it('the host turns team mode on in a 4-seat room', async () => {
    const { transport } = lobby('me', teamRoom(['me', 'bob'], false));
    const sw = screen.getByTestId('teams-switch');
    expect(sw).toHaveAttribute('role', 'switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(transport.emittedOf('room:setTeams')).toEqual([{ roomId: ROOM_ID, teams: true }]);
  });

  it('no switch for guests or rooms that are not 4 seats', () => {
    lobby('bob', teamRoom(['me', 'bob'], false));
    expect(screen.queryByTestId('teams-switch')).toBeNull();
  });

  it('members are grouped by team (seats 0+2 vs 1+3) with empty seats; start waits for four', () => {
    lobby('me', teamRoom(['me', 'bob', 'cat']));
    const teams = screen.getByTestId('lobby-teams');
    const blue = within(teams).getByRole('region', { name: teamName(0) });
    const orange = within(teams).getByRole('region', { name: teamName(1) });
    expect(within(blue).getByTestId('member-me')).toBeInTheDocument();
    expect(within(blue).getByTestId('member-cat')).toBeInTheDocument();
    expect(within(orange).getByTestId('member-bob')).toBeInTheDocument();
    expect(within(orange).getByText(t.teams.emptySeat)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.teams.needFour })).toBeDisabled();
    expect(screen.getByTestId('lobby-mode')).toHaveTextContent(t.teams.modeLine);
  });

  it('the host swaps two seats: tap one, then the other', async () => {
    const { transport } = lobby('me', teamRoom(['me', 'bob', 'cat', 'dan']));
    await userEvent.click(screen.getByTestId('swap-bob'));
    expect(screen.getByTestId('swap-bob')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('swap-cat')).toHaveAccessibleName(t.teams.swapWith('CAT'));
    await userEvent.click(screen.getByTestId('swap-cat'));
    expect(transport.emittedOf('room:swapSeats')).toEqual([{ roomId: ROOM_ID, a: 'bob', b: 'cat' }]);
    expect(screen.getByTestId('swap-bob')).toHaveAttribute('aria-pressed', 'false');
  });

  it('tapping the picked member again cancels; guests get no swap buttons', async () => {
    const { transport } = lobby('me', teamRoom(['me', 'bob', 'cat', 'dan']));
    await userEvent.click(screen.getByTestId('swap-bob'));
    await userEvent.click(screen.getByTestId('swap-bob'));
    expect(transport.emittedOf('room:swapSeats')).toEqual([]);
  });

  it('guests see the teams but no swap buttons', () => {
    lobby('bob', teamRoom(['me', 'bob', 'cat', 'dan']));
    expect(screen.getByTestId('lobby-teams')).toBeInTheDocument();
    expect(screen.queryByTestId('swap-me')).toBeNull();
  });
});

describe('Home: team mode', () => {
  it('the 2v2 switch appears with 4 players and creates a team room', async () => {
    const { transport } = setup('/');
    await userEvent.type(screen.getByRole('textbox', { name: t.home.nickname }), 'Dana');
    expect(screen.queryByTestId('teams-switch')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: '4' })[0]!);
    await userEvent.click(screen.getByTestId('teams-switch'));
    await userEvent.click(screen.getByRole('button', { name: t.home.create }));
    expect(transport.emittedOf('room:create')).toEqual([
      expect.objectContaining({ maxPlayers: 4, config: { mode: 'podkidnoy', teams: true } }),
    ]);
  });

  it('switching to another player count drops team mode', async () => {
    const { transport } = setup('/');
    await userEvent.type(screen.getByRole('textbox', { name: t.home.nickname }), 'Dana');
    await userEvent.click(screen.getAllByRole('button', { name: '4' })[0]!);
    await userEvent.click(screen.getByTestId('teams-switch'));
    await userEvent.click(screen.getAllByRole('button', { name: '5' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: t.home.create }));
    expect(transport.emittedOf('room:create')).toEqual([expect.objectContaining({ maxPlayers: 5, config: { mode: 'podkidnoy' } })]);
  });

  it('vs computer with 3 opponents: me + a bot partner vs 2 bots', async () => {
    const { transport } = setup('/');
    await userEvent.type(screen.getByRole('textbox', { name: t.home.nickname }), 'Dana');
    // The opponent-count row is the second row of numbered buttons.
    await userEvent.click(screen.getAllByRole('button', { name: '3' })[1]!);
    await userEvent.click(screen.getByTestId('vs-teams-switch'));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.home.vsComputer) }));
    expect(transport.emittedOf('room:create')).toEqual([
      expect.objectContaining({ maxPlayers: 4, config: { mode: 'podkidnoy', teams: true } }),
    ]);
  });
});
