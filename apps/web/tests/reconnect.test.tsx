import type { ClientMove } from '@durak/shared';
import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { c, gameState, makeView, renderTable, ROOM_ID } from './helpers';

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
