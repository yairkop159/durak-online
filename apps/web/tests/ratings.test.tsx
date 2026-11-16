import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { GameOverPayload, GameRatingsPayload, PlayerStats } from '@durak/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { RATING_PENDING_SHOW_MS, formatDelta, ratingDisplay } from '../src/game/ratingDelta';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage, SessionTokens } from '../src/net/sessionStore';
import { FakeTransport, gameState, makeView, roomState, ROOM_ID } from './helpers';

const TOKEN = 't'.repeat(43);
const finishedView = makeView({ phase: { kind: 'finished', durak: 'bob' }, finished: ['me'], counts: { me: 0, bob: 3 } });
const stat = (n: number): PlayerStats => ({ boutsAttacked: n, boutsDefended: 1, defenses: 1, takes: 0, cardsTaken: 0, throwIns: 0, transfers: 0, cardsPlayed: n });
const gameOver: GameOverPayload = {
  roomId: ROOM_ID,
  durakId: 'bob',
  finishOrder: ['me'],
  endReason: 'normal',
  botAssisted: [],
  forfeits: [],
  stats: { me: stat(3), bob: stat(2) },
};
const rated = (meDelta = 12, gameId = 'g1'): GameRatingsPayload => ({
  roomId: ROOM_ID,
  gameId,
  status: 'rated',
  entries: [
    { playerId: 'me', before: 1000, after: 1000 + meDelta, delta: meDelta },
    { playerId: 'bob', before: 1000, after: 1000 - meDelta, delta: -meDelta },
  ],
});
const pending: GameRatingsPayload = { roomId: ROOM_ID, gameId: 'g1', status: 'pending' };

afterEach(() => {
  vi.useRealTimers();
});

/** The app on /room/ROOM_ID with a resumed session and the finished game (`withGameOver` = watched it end). */
function setup(withGameOver: boolean) {
  window.history.replaceState(null, '', `/room/${ROOM_ID}`);
  const storage = new MemoryStorage();
  new SessionTokens(storage).set(ROOM_ID, TOKEN);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage, now: () => Date.now() });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => {
    transport.connect();
    transport.serverSends('session:issued', { sessionToken: TOKEN, playerId: 'me', roomId: ROOM_ID });
    transport.serverSends('room:state', roomState('finished'));
    transport.serverSends('game:state', gameState(finishedView, 9));
    if (withGameOver) transport.serverSends('game:over', gameOver);
  });
  const send = (payload: GameRatingsPayload) => act(() => transport.serverSends('game:ratings', payload));
  return { transport, send };
}

const openStatsTable = () => fireEvent.click(screen.getByRole('button', { name: t.stats.showAll }));

describe('rating change on the game-over screen', () => {
  it('nothing at all without a game:ratings event (ratings off or Postgres down)', () => {
    setup(true);
    expect(screen.getByTestId('game-over-headline')).toBeInTheDocument();
    expect(screen.queryByTestId('rating-pending')).toBeNull();
    expect(screen.queryByTestId('rating-delta')).toBeNull();
    expect(screen.queryByTestId('rating-unrated')).toBeNull();
    openStatsTable();
    expect(within(screen.getByTestId('stats-table')).queryByText(t.rating.column)).toBeNull();
  });

  it('"calculating" for a few seconds only; a late rated event still shows my change big and the others in the table', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { send } = setup(true);
    send(pending);
    expect(screen.getByTestId('rating-pending')).toHaveTextContent(t.rating.calculating);
    act(() => vi.advanceTimersByTime(RATING_PENDING_SHOW_MS - 100));
    expect(screen.getByTestId('rating-pending')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId('rating-pending')).toBeNull(); // quietly gone, no error

    act(() => vi.advanceTimersByTime(60_000)); // Postgres was slow; the result arrives much later
    send(rated(12));
    const mine = screen.getByTestId('rating-delta');
    expect(mine).toHaveTextContent('+12');
    expect(mine.querySelector('.text-gain')).not.toBeNull();
    expect(screen.getByTestId('rating-new')).toHaveTextContent(t.rating.newRating(1012));
    expect(mine).toHaveTextContent(t.rating.changeLabel(12)); // screen readers
    // With the stats table, the others are in its rating column (no separate list).
    expect(screen.queryByTestId('rating-others')).toBeNull();
    openStatsTable();
    expect(within(screen.getByTestId('stats-table')).getByText(t.rating.column)).toBeInTheDocument();
    expect(screen.getByTestId('stats-rating-bob')).toHaveTextContent(formatDelta(-12));
    expect(screen.getByTestId('stats-rating-bob').querySelector('.text-loss')).not.toBeNull();
  });

  it('a loss is red with a real minus sign', () => {
    const { send } = setup(true);
    send(rated(-8));
    const mine = screen.getByTestId('rating-delta');
    expect(mine).toHaveTextContent('−8');
    expect(mine.querySelector('.text-loss')).not.toBeNull();
    expect(screen.getByTestId('rating-new')).toHaveTextContent(t.rating.newRating(992));
  });

  it('a game:ratings for another game (a rematch or restart already started) is ignored', () => {
    const { send } = setup(true);
    send(rated(12, 'older-game'));
    expect(screen.queryByTestId('rating-delta')).toBeNull();
  });

  it('reload: only the finished view and the re-sent status (no game:over) still show the delta and the others', () => {
    const { send } = setup(false);
    expect(screen.getByTestId('game-over-headline')).toBeInTheDocument();
    send(rated(12));
    expect(screen.getByTestId('rating-delta')).toHaveTextContent('+12');
    const others = screen.getByTestId('rating-others');
    expect(others).toHaveTextContent(t.rating.others);
    expect(others).toHaveTextContent('BOB');
    expect(others).toHaveTextContent(formatDelta(-12));
  });

  it('unrated: one quiet line with the reason', () => {
    const { send } = setup(true);
    send({ roomId: ROOM_ID, gameId: 'g1', status: 'unrated', reason: 'notEnoughProfiles' });
    expect(screen.getByTestId('rating-unrated')).toHaveTextContent(t.rating.unrated.notEnoughProfiles);
    send({ roomId: ROOM_ID, gameId: 'g1', status: 'unrated', reason: 'notFinished' });
    expect(screen.getByTestId('rating-unrated')).toHaveTextContent(t.rating.unrated.notFinished);
    expect(screen.queryByTestId('rating-delta')).toBeNull();
  });

  it('a malformed payload (delta not after - before) is dropped', () => {
    const { send } = setup(true);
    const bad = rated(12);
    send({ ...bad, entries: bad.status === 'rated' ? [{ ...bad.entries[0]!, delta: 99 }, bad.entries[1]!] : [] } as GameRatingsPayload);
    expect(screen.queryByTestId('rating-delta')).toBeNull();
  });

  it('a rated game I was not rated in (spectator / no profile): no big number, the others listed', () => {
    const { send } = setup(false);
    send({ roomId: ROOM_ID, gameId: 'g1', status: 'rated', entries: [
      { playerId: 'bob', before: 1000, after: 984, delta: -16 },
      { playerId: 'carl', before: 1000, after: 1016, delta: 16 },
    ] });
    expect(screen.queryByTestId('rating-delta')).toBeNull();
    expect(screen.getByTestId('rating-others')).toHaveTextContent(formatDelta(-16));
  });
});

describe('ratingDisplay / formatDelta (pure)', () => {
  it('formats signs and orders the others by seat', () => {
    expect([formatDelta(5), formatDelta(-5), formatDelta(0)]).toEqual(['+5', '−5', '0']);
    const payload: GameRatingsPayload = {
      roomId: ROOM_ID,
      gameId: 'g1',
      status: 'rated',
      entries: [
        { playerId: 'c', before: 1000, after: 990, delta: -10 },
        { playerId: 'a', before: 1000, after: 1005, delta: 5 },
        { playerId: 'b', before: 1000, after: 1005, delta: 5 },
      ],
    };
    const d = ratingDisplay({ payload, receivedAt: 0 }, 'b', ['a', 'b', 'c'], 0);
    expect(d).toEqual({ kind: 'rated', mine: payload.entries[2], others: [payload.entries[1], payload.entries[0]] });
    expect(ratingDisplay({ payload: pending, receivedAt: 0 }, 'b', [], RATING_PENDING_SHOW_MS)).toEqual({ kind: 'none' });
    expect(ratingDisplay(null, 'b', [], 0)).toEqual({ kind: 'none' });
  });
});
