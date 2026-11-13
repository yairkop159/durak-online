import type { RoomStatePayload } from '@durak/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { FakeTransport, gameState, makeView, renderTable, ROOM_ID, roomState } from './helpers';

const TOKEN = 'x'.repeat(43);

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

function withBot(base: RoomStatePayload, maxPlayers = 3): RoomStatePayload {
  return {
    ...base,
    maxPlayers,
    members: [
      ...base.members,
      { playerId: 'bot1', nickname: 'Bot 1', connected: true, isBot: true, botDifficulty: 'hard', afk: false },
    ],
  };
}

function lobbyAs(playerId: string, room: RoomStatePayload) {
  const ctx = setup(`/room/${ROOM_ID}`);
  act(() => {
    ctx.transport.serverSends('session:issued', { sessionToken: TOKEN, playerId, roomId: ROOM_ID });
    ctx.transport.serverSends('room:state', room);
  });
  return ctx;
}

describe('lobby bots', () => {
  it('the host sees add-bot with a difficulty picker and a remove button on bot rows', async () => {
    const { transport } = lobbyAs('me', withBot(roomState('lobby', ['me', 'bob']), 4));
    const botRow = screen.getByTestId('member-bot1');
    expect(within(botRow).getByText(t.bots.name('1'))).toBeInTheDocument();
    expect(within(botRow).getByTestId('bot-badge')).toHaveTextContent(t.bots.difficulties.hard);

    await userEvent.click(screen.getByRole('radio', { name: t.bots.difficulties.easy }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.bots.add) }));
    expect(transport.emittedOf('room:addBot')).toEqual([{ roomId: ROOM_ID, difficulty: 'easy' }]);

    await userEvent.click(within(botRow).getByRole('button', { name: t.bots.remove(t.bots.name('1')) }));
    expect(transport.emittedOf('room:removeBot')).toEqual([{ roomId: ROOM_ID, playerId: 'bot1' }]);
  });

  it('a guest sees the bot badge but no bot controls', () => {
    lobbyAs('bob', withBot(roomState('lobby', ['me', 'bob']), 4));
    expect(screen.getByTestId('bot-badge')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(t.bots.add) })).toBeNull();
    expect(screen.queryByRole('button', { name: t.bots.remove(t.bots.name('1')) })).toBeNull();
  });

  it('no add-bot button when the room is full', () => {
    lobbyAs('me', withBot(roomState('lobby', ['me', 'bob']), 3));
    expect(screen.queryByRole('button', { name: new RegExp(t.bots.add) })).toBeNull();
  });
});

describe('play vs computer', () => {
  it('emits room:create (2 seats), then room:addBot on the lobby, then game:start once the bot is seated', async () => {
    const { transport } = setup('/');
    await userEvent.type(screen.getByRole('textbox'), 'Dana');
    await userEvent.click(screen.getByRole('radio', { name: t.bots.difficulties.hard }));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.home.vsComputer) }));
    expect(transport.emittedOf('room:create')).toEqual([{ nickname: 'Dana', maxPlayers: 2, config: { mode: 'podkidnoy' } }]);
    expect(transport.emittedOf('room:addBot')).toEqual([]);

    const lobby: RoomStatePayload = { ...roomState('lobby', ['me']), maxPlayers: 2 };
    act(() => {
      transport.serverSends('session:issued', { sessionToken: TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('room:state', lobby);
    });
    expect(transport.emittedOf('room:addBot')).toEqual([{ roomId: ROOM_ID, difficulty: 'hard' }]);
    expect(transport.emittedOf('game:start')).toEqual([]);

    act(() => transport.serverSends('room:state', withBot(lobby, 2)));
    expect(transport.emittedOf('game:start')).toEqual([{ roomId: ROOM_ID }]);

    // Later lobby updates (e.g. a rematch) never re-trigger it.
    act(() => transport.serverSends('room:state', withBot(lobby, 2)));
    expect(transport.emittedOf('game:start')).toHaveLength(1);
    expect(transport.emittedOf('room:addBot')).toHaveLength(1);
  });

  it('an error cancels the flow', async () => {
    const { transport } = setup('/');
    await userEvent.type(screen.getByRole('textbox'), 'Dana');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(t.home.vsComputer) }));
    act(() => {
      transport.serverSends('session:issued', { sessionToken: TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('error', { code: 'INTERNAL', message: 'x' });
      transport.serverSends('room:state', { ...roomState('lobby', ['me']), maxPlayers: 2 });
    });
    expect(transport.emittedOf('room:addBot')).toEqual([]);
  });
});

describe('table bots', () => {
  it('a bot seat shows the robot badge; an AFK human shows that the bot plays for them', () => {
    const view = makeView({ counts: { me: 6, bot1: 6, bob: 6 }, attacker: 'bot1', defender: 'bob' });
    const { transport } = renderTable(view);
    act(() => {
      const base = roomState('playing', ['me', 'bot1', 'bob']);
      transport.serverSends('room:state', {
        ...base,
        members: base.members.map((m) =>
          m.playerId === 'bot1'
            ? { ...m, nickname: 'Bot 1', isBot: true, botDifficulty: 'medium' }
            : m.playerId === 'me'
              ? { ...m, afk: true }
              : m,
        ),
      });
      transport.serverSends('game:state', gameState(view, 4));
    });
    const botSeat = screen.getByTestId('seat-bot1');
    expect(within(botSeat).getByTestId('bot-badge')).toHaveTextContent(t.bots.difficulties.medium);
    expect(within(botSeat).getByText(t.bots.name('1'))).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-me')).getByText(t.bots.playingForYou)).toBeInTheDocument();
  });
});
