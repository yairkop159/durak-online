import type { ClientMove } from '@durak/shared';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { c, gameState, makeView, renderTable, roomState, ROOM_ID } from './helpers';

const SESSION_TOKEN = 'x'.repeat(43); // the token renderTable's session:issued carries
const attack7H: ClientMove = { type: 'attack', card: c('7H') };

describe('automatic reconnects (regression: NOT_IN_ROOM after a network blip)', () => {
  it('a new socket resumes BEFORE anything else, and moves are held back until it is bound again', () => {
    const view = makeView({ hand: '7H 8C', attacker: 'me', defender: 'bob' });
    const { transport, client } = renderTable(view);

    act(() => client.sendMove(attack7H));
    expect(transport.emittedOf('game:move')).toHaveLength(1); // bound: sent

    // socket.io drops and reconnects by itself (not GameClient.reconnect()).
    act(() => transport.disconnect());
    act(() => client.sendMove(attack7H)); // disconnected: dropped, never buffered
    const sinceReconnect = transport.emitted.length;
    act(() => transport.connect());

    expect(transport.emitted.slice(sinceReconnect)).toEqual([
      { event: 'session:resume', payload: { sessionToken: SESSION_TOKEN } },
    ]);
    expect(client.state.session?.roomId).toBe(ROOM_ID); // still shown while resuming
    expect(client.state.bound).toBe(false);

    act(() => client.sendMove(attack7H)); // resuming: dropped
    expect(transport.emittedOf('game:move')).toHaveLength(1);

    act(() => {
      transport.serverSends('session:issued', { sessionToken: SESSION_TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('game:state', gameState(view, 3));
    });
    expect(client.state.bound).toBe(true);
    act(() => client.sendMove(attack7H));
    expect(transport.emittedOf('game:move')).toHaveLength(2);
  });

  it('resumes on every reconnect, also without sessionStorage (the held session token is used)', () => {
    const view = makeView({ hand: '7H', attacker: 'me', defender: 'bob' });
    const { transport, client } = renderTable(view, { storage: null });
    for (let i = 1; i <= 3; i++) {
      act(() => {
        transport.disconnect();
        transport.connect();
      });
      expect(transport.emittedOf('session:resume')).toHaveLength(i);
      act(() => transport.serverSends('session:issued', { sessionToken: SESSION_TOKEN, playerId: 'me', roomId: ROOM_ID }));
    }
    expect(client.state.bound).toBe(true);
  });

  it('a connect on an already bound socket does not resume again', () => {
    const { transport } = renderTable(makeView({ hand: '7H' }));
    act(() => transport.connect()); // a duplicate connect event, same socket
    expect(transport.emittedOf('session:resume')).toHaveLength(0);
  });

  it('a seat that is gone by the time we resume clears the stale table', () => {
    const { transport, client } = renderTable(makeView({ hand: '7H' }));
    act(() => {
      transport.disconnect();
      transport.connect();
      transport.serverSends('error', { code: 'INVALID_SESSION', message: 'gone' });
    });
    expect(client.state.session).toBeNull();
    expect(client.state.game).toBeNull();
    expect(client.state.resumeStatus).toBe('failed');
  });
});

const handCard = (id: string) =>
  within(screen.getByTestId('hand'))
    .getAllByRole('button')
    .find((b) => b.dataset.card === id)!;

describe('NOT_IN_ROOM while holding a session (hardening)', () => {
  it('re-binds with session:resume and resyncs instead of only showing the error', () => {
    const view = makeView({ hand: '7H 8C', attacker: 'me', defender: 'bob' });
    const { transport, client } = renderTable(view);
    const resumesBefore = transport.emittedOf('session:resume').length;

    act(() => transport.serverSends('error', { code: 'NOT_IN_ROOM', message: 'You are not in a room' }));

    expect(transport.emittedOf('session:resume')).toEqual([
      ...Array(resumesBefore).fill(expect.anything()),
      { sessionToken: SESSION_TOKEN },
    ]);
    expect(screen.queryByRole('alert')).toBeNull(); // no error toast
    expect(screen.getByRole('status')).toHaveTextContent(t.connection.reconnecting);

    // A second NOT_IN_ROOM while the resume is in flight doesn't start another one.
    act(() => transport.serverSends('error', { code: 'NOT_IN_ROOM', message: 'again' }));
    expect(transport.emittedOf('session:resume')).toHaveLength(resumesBefore + 1);

    // The resume answer is the resync: session, room and the current game state.
    const newer = makeView({ hand: '8C', attacker: 'bob', defender: 'me', table: [['7H', null]] });
    act(() => {
      transport.serverSends('session:issued', { sessionToken: SESSION_TOKEN, playerId: 'me', roomId: ROOM_ID });
      transport.serverSends('room:state', roomState('playing'));
      transport.serverSends('game:state', gameState(newer, 9));
    });
    expect(client.state.bound).toBe(true);
    expect(client.state.game?.version).toBe(9);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('without a session, NOT_IN_ROOM is still shown as an error', () => {
    const { transport, client } = renderTable(makeView({ hand: '7H' }));
    act(() => client.leaveRoom());
    const resumes = transport.emittedOf('session:resume').length;
    act(() => transport.serverSends('error', { code: 'NOT_IN_ROOM', message: 'You are not in this room' }));
    expect(screen.getByRole('alert')).toHaveTextContent(t.errors.NOT_IN_ROOM);
    expect(transport.emittedOf('session:resume')).toHaveLength(resumes);
  });
});

describe('"reconnecting" banner and blocked input', () => {
  it('while disconnected or resuming: banner shown, no actions offered, clicks send nothing', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const view = makeView({ hand: '7H 8C', attacker: 'bob', defender: 'me', table: [['6H', null]] });
    const { transport } = renderTable(view);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('toolbar', { name: t.table.actions })).toBeInTheDocument(); // take

    act(() => transport.disconnect());
    expect(screen.getByRole('status')).toHaveTextContent(t.connection.reconnecting);
    expect(screen.queryByRole('toolbar', { name: t.table.actions })).toBeNull();
    await user.click(handCard('7H'));
    await user.click(handCard('7H'));

    act(() => transport.connect()); // resuming
    expect(screen.getByRole('status')).toHaveTextContent(t.connection.reconnecting);
    await user.click(handCard('8C'));
    expect(transport.emittedOf('game:move')).toEqual([]);

    act(() => transport.serverSends('session:issued', { sessionToken: SESSION_TOKEN, playerId: 'me', roomId: ROOM_ID }));
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(screen.getByRole('button', { name: t.table.take }));
    expect(transport.emittedOf('game:move')).toEqual([{ roomId: ROOM_ID, move: { type: 'take' }, expectedVersion: 3 }]);
  });
});
