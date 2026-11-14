import { describe, expect, it } from 'vitest';
import { initialState, reducer, type ClientState } from '../src/net/store';
import { gameState, makeView, roomState, ROOM_ID } from './helpers';

const session = { sessionToken: 't'.repeat(43), playerId: 'me', roomId: ROOM_ID };
const connected: ClientState = { ...initialState, connection: 'connected' };

describe('store reducer', () => {
  it('tracks the connection status', () => {
    expect(reducer(initialState, { type: 'connection', status: 'connected' }).connection).toBe('connected');
    const pending = reducer(connected, { type: 'resume:start' });
    const dropped = reducer(pending, { type: 'connection', status: 'disconnected' });
    expect(dropped).toMatchObject({ connection: 'disconnected', resumeStatus: 'idle' });
  });

  it('session:issued stores the session and ends a pending resume', () => {
    const pending = reducer({ ...connected, roomNotFound: true }, { type: 'resume:start' });
    const s = reducer(pending, { type: 'session:issued', payload: session });
    expect(s).toMatchObject({ session, resumeStatus: 'idle', roomNotFound: false });
  });

  it('room:state replaces the room; going back to the lobby clears the game and its result', () => {
    let s = reducer(connected, { type: 'room:state', payload: roomState('playing') });
    s = reducer(s, { type: 'game:state', payload: gameState(makeView(), 5), receivedAt: 10 });
    s = reducer(s, { type: 'game:over', payload: { roomId: ROOM_ID, durakId: 'bob', finishOrder: ['me'], endReason: 'normal', botAssisted: [], forfeits: [], stats: {} } });
    s = reducer(s, { type: 'room:state', payload: roomState('finished') });
    expect(s.game).not.toBeNull();
    expect(s.gameOver).not.toBeNull();

    s = reducer(s, { type: 'room:state', payload: roomState('lobby') });
    expect(s).toMatchObject({ room: { status: 'lobby' }, game: null, gameOver: null });
  });

  it('game:state stores version, view, deadline, server time and local receipt time', () => {
    const view = makeView();
    const s = reducer(connected, {
      type: 'game:state',
      payload: gameState(view, 7, { turnDeadline: 31_000, serverTime: 1_000 }),
      receivedAt: 555,
    });
    expect(s.game).toEqual({ roomId: ROOM_ID, gameId: 'g1', version: 7, view, turnDeadline: 31_000, serverTime: 1_000, receivedAt: 555 });
  });

  it('ignores an older game:state but accepts a re-sent current one', () => {
    const s = reducer(connected, { type: 'game:state', payload: gameState(makeView(), 7), receivedAt: 1 });
    expect(reducer(s, { type: 'game:state', payload: gameState(makeView(), 6), receivedAt: 2 })).toBe(s);
    expect(reducer(s, { type: 'game:state', payload: gameState(makeView(), 7), receivedAt: 2 }).game?.receivedAt).toBe(2);
  });

  it('game:over stores the result', () => {
    const payload = { roomId: ROOM_ID, durakId: null, finishOrder: ['me', 'bob'], endReason: 'abandoned' as const, botAssisted: [], forfeits: [], stats: {} };
    expect(reducer(connected, { type: 'game:over', payload }).gameOver).toEqual(payload);
  });

  it('swallows STALE_STATE (a resync game:state follows) but records other errors', () => {
    expect(reducer(connected, { type: 'error', payload: { code: 'STALE_STATE', message: 'x' } })).toBe(connected);
    const s1 = reducer(connected, { type: 'error', payload: { code: 'NOT_YOUR_TURN', message: 'x' } });
    const s2 = reducer(s1, { type: 'error', payload: { code: 'NOT_YOUR_TURN', message: 'x' } });
    expect(s1.lastError).toMatchObject({ code: 'NOT_YOUR_TURN', id: 1 });
    expect(s2.lastError?.id).toBe(2);
    expect(reducer(s2, { type: 'dismissError' }).lastError).toBeNull();
  });

  it('a rejected resume marks the resume failed; ROOM_NOT_FOUND also flags the room', () => {
    const pending = reducer(connected, { type: 'resume:start' });
    expect(reducer(pending, { type: 'error', payload: { code: 'INVALID_SESSION', message: '' } })).toMatchObject({
      resumeStatus: 'failed',
      roomNotFound: false,
    });
    expect(reducer(pending, { type: 'error', payload: { code: 'ROOM_NOT_FOUND', message: '' } })).toMatchObject({
      resumeStatus: 'failed',
      roomNotFound: true,
    });
    // Unrelated errors while resuming don't fail it.
    expect(reducer(pending, { type: 'error', payload: { code: 'INTERNAL', message: '' } }).resumeStatus).toBe('pending');
  });

  it('left forgets the room but keeps the connection', () => {
    let s = reducer(connected, { type: 'session:issued', payload: session });
    s = reducer(s, { type: 'room:state', payload: roomState('lobby') });
    s = reducer(s, { type: 'left' });
    expect(s).toEqual({ ...initialState, connection: 'connected' });
  });
});
