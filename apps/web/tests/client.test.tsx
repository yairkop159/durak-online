import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage, SessionTokens } from '../src/net/sessionStore';
import { FakeTransport, gameState, makeView, roomState, ROOM_ID } from './helpers';

const TOKEN = 'k'.repeat(43);

function setup(path: string, storage = new MemoryStorage()) {
  window.history.replaceState(null, '', path);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  return { transport, client, storage, tokens: new SessionTokens(storage) };
}

describe('session resume', () => {
  it('resumes the stored session of the room in the URL on connect, and again on every reconnect', () => {
    const storage = new MemoryStorage();
    new SessionTokens(storage).set(ROOM_ID, TOKEN);
    const { transport } = setup(`/room/${ROOM_ID}`, storage);
    expect(screen.getByText(t.common.loading)).toBeInTheDocument();

    act(() => transport.connect());
    expect(transport.emittedOf('session:resume')).toEqual([{ sessionToken: TOKEN }]);

    act(() => {
      transport.disconnect();
      transport.connect();
    });
    expect(transport.emittedOf('session:resume')).toHaveLength(2);
  });

  it('a rejected token is dropped and the nickname prompt appears; joining stores the new token', async () => {
    const storage = new MemoryStorage();
    new SessionTokens(storage).set(ROOM_ID, TOKEN);
    const { transport, tokens } = setup(`/room/${ROOM_ID}`, storage);
    act(() => transport.connect());
    act(() => transport.serverSends('error', { code: 'INVALID_SESSION', message: 'expired' }));
    expect(tokens.get(ROOM_ID)).toBeNull();

    await userEvent.type(screen.getByRole('textbox'), 'Dana');
    await userEvent.click(screen.getByRole('button', { name: t.join.submit }));
    expect(transport.emittedOf('room:join')).toEqual([{ roomId: ROOM_ID, nickname: 'Dana' }]);

    act(() => {
      transport.serverSends('session:issued', { sessionToken: 'n'.repeat(43), playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('room:state', roomState('lobby'));
    });
    expect(tokens.get(ROOM_ID)).toBe('n'.repeat(43));
    expect(screen.getByText(t.lobby.title)).toBeInTheDocument();
  });

  it('without a stored session the invite link asks for a nickname and does not resume', () => {
    const { transport } = setup(`/room/${ROOM_ID}`);
    act(() => transport.connect());
    expect(transport.emittedOf('session:resume')).toEqual([]);
    expect(screen.getByRole('heading', { name: t.join.title })).toBeInTheDocument();
  });

  it('an unknown room shows "room not found"', () => {
    const storage = new MemoryStorage();
    new SessionTokens(storage).set(ROOM_ID, TOKEN);
    const { transport } = setup(`/room/${ROOM_ID}`, storage);
    act(() => transport.connect());
    act(() => transport.serverSends('error', { code: 'ROOM_NOT_FOUND', message: '' }));
    expect(screen.getByRole('heading', { name: t.notFound.title })).toBeInTheDocument();
  });
});

describe('home and lobby', () => {
  it('creating a room sends room:create and navigates to the room', async () => {
    const { transport } = setup('/');
    act(() => transport.connect());
    await userEvent.type(screen.getByRole('textbox'), 'Dana');
    await userEvent.click(within(screen.getByRole('group', { name: t.home.players })).getByRole('button', { name: '4' }));
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(t.home.modes.perevodnoy) }));
    await userEvent.click(screen.getByRole('button', { name: t.home.create }));
    expect(transport.emittedOf('room:create')).toEqual([
      { nickname: 'Dana', maxPlayers: 4, config: { mode: 'perevodnoy' } },
    ]);
    act(() => {
      transport.serverSends('session:issued', { sessionToken: TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('room:state', roomState('lobby'));
    });
    expect(window.location.pathname).toBe(`/room/${ROOM_ID}`);
    expect(screen.getByRole('button', { name: t.lobby.start })).toBeInTheDocument();
  });

  it('game over shows the durak and "back to lobby" sends room:rematch', async () => {
    const storage = new MemoryStorage();
    new SessionTokens(storage).set(ROOM_ID, TOKEN);
    const { transport } = setup(`/room/${ROOM_ID}`, storage);
    act(() => {
      transport.connect();
      transport.serverSends('session:issued', { sessionToken: TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('room:state', roomState('finished'));
      transport.serverSends(
        'game:state',
        gameState(makeView({ phase: { kind: 'finished', durak: 'bob' }, finished: ['me'], counts: { me: 0, bob: 3 } })),
      );
      transport.serverSends('game:over', { roomId: ROOM_ID, durakId: 'bob', finishOrder: ['me'], endReason: 'forfeit', botAssisted: [], forfeits: [], stats: {} });
    });
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent(t.gameOver.forfeit('BOB'));
    await userEvent.click(screen.getByRole('button', { name: t.gameOver.backToLobby }));
    expect(transport.emittedOf('room:rematch')).toEqual([{ roomId: ROOM_ID }]);
    act(() => transport.serverSends('room:state', roomState('lobby')));
    expect(screen.getByText(t.lobby.title)).toBeInTheDocument();
  });
});
