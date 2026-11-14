import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { initialState, reducer, REACTION_SHOW_MS, type ClientState } from '../src/net/store';
import { ReactionBucket } from '../src/reactions/bucket';
import { DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY } from '../src/settings/settings';
import { makeView, renderTable, ROOM_ID } from './helpers';

const inRoom: ClientState = {
  ...initialState,
  connection: 'connected',
  bound: true,
  session: { sessionToken: 'x'.repeat(43), playerId: 'me', roomId: ROOM_ID },
};

describe('reactions in the store', () => {
  it('keeps reactions for my room only, and prunes them by arrival time', () => {
    let s = reducer(inRoom, { type: 'reaction', payload: { roomId: ROOM_ID, playerId: 'bob', reactionId: 'fire' }, receivedAt: 100 });
    s = reducer(s, { type: 'reaction', payload: { roomId: 'otherRoom', playerId: 'x', reactionId: 'fire' }, receivedAt: 150 });
    s = reducer(s, { type: 'reaction', payload: { roomId: ROOM_ID, playerId: 'me', reactionId: 'again' }, receivedAt: 200 });
    expect(s.reactions.map((r) => [r.id, r.playerId, r.reactionId])).toEqual([
      [1, 'bob', 'fire'],
      [2, 'me', 'again'],
    ]);
    s = reducer(s, { type: 'reactions:prune', before: 150 });
    expect(s.reactions.map((r) => r.playerId)).toEqual(['me']);
    expect(reducer(s, { type: 'reactions:prune', before: 0 })).toBe(s);
    expect(reducer(s, { type: 'left' }).reactions).toEqual([]);
    expect(REACTION_SHOW_MS).toBe(2_500);
  });

  it('the client-side bucket mirrors the server: burst 3, then one every 2 s', () => {
    let now = 0;
    const bucket = new ReactionBucket(3, 2_000, () => now);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    expect(bucket.readyIn()).toBe(2_000);
    now = 1_500;
    expect(bucket.readyIn()).toBe(500);
    now = 2_000;
    expect(bucket.tryTake()).toBe(true);
  });
});

describe('settings v2 (show reactions)', () => {
  it('migrates v1 data: everything kept, showReactions defaults to on', () => {
    const v1 = { v: 1, sfx: { enabled: false, volume: 0.2 }, music: { enabled: true, volume: 0.5 }, animationSpeed: 'fast', showTips: false, tipsSeen: ['firstAttack'] };
    expect(parseSettings(JSON.stringify(v1))).toEqual({ ...v1, v: 2, showReactions: true });
    expect(DEFAULT_SETTINGS.showReactions).toBe(true);
    expect(parseSettings(JSON.stringify({ v: 2, showReactions: false })).showReactions).toBe(false);
    expect(parseSettings(JSON.stringify({ v: 2, showReactions: 'yes' })).showReactions).toBe(true);
  });
});

const twoPlayers = () => makeView({ hand: '7S 8S 9S 10S JS QS' });

describe('reactions on the table', () => {
  it('my button opens the picker, a choice is sent as room:react and closes it; the limit greys it out', () => {
    const { transport } = renderTable(twoPlayers());
    fireEvent.click(screen.getByTestId('reaction-button'));
    const picker = screen.getByTestId('reaction-picker');
    expect(within(picker).getAllByRole('button')).toHaveLength(9);
    expect(within(picker).getByText('עוד סיבוב?')).toBeTruthy();
    fireEvent.click(within(picker).getByTestId('reaction-fire'));
    expect(transport.emittedOf('room:react')).toEqual([{ roomId: ROOM_ID, reactionId: 'fire' }]);
    expect(screen.queryByTestId('reaction-picker')).toBeNull();

    for (const id of ['laugh', 'clap']) {
      fireEvent.click(screen.getByTestId('reaction-button'));
      fireEvent.click(screen.getByTestId(`reaction-${id}`));
    }
    fireEvent.click(screen.getByTestId('reaction-button'));
    // The test clock never moves: the bucket stays empty, so every choice is disabled.
    expect((screen.getByTestId('reaction-nice') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('reaction-picker')).toBeNull();
    expect(transport.emittedOf('room:react')).toHaveLength(3);
  });

  it('an incoming reaction shows a bubble over the sender’s seat and is announced politely', () => {
    const { transport } = renderTable(twoPlayers());
    act(() => transport.serverSends('room:reaction', { roomId: ROOM_ID, playerId: 'bob', reactionId: 'ohNo' }));
    const bubble = within(screen.getByTestId('seat-bob')).getByTestId('reaction-bubble-bob');
    expect(bubble.textContent).toBe('אוי לא');
    expect(bubble.className).toContain('pointer-events-none');
    const live = screen.getByTestId('reaction-announcer');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('BOB: אוי לא');
  });

  it('"show reactions" off: no bubbles and no button', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, showReactions: false }));
    const { transport } = renderTable(twoPlayers());
    act(() => transport.serverSends('room:reaction', { roomId: ROOM_ID, playerId: 'bob', reactionId: 'fire' }));
    expect(screen.queryByTestId('reaction-bubble-bob')).toBeNull();
    expect(screen.queryByTestId('reaction-button')).toBeNull();
    expect(screen.getByTestId('reaction-announcer').textContent).toBe('');
  });

  it('spectators get bubbles but no button', () => {
    const view = makeView({ viewer: null });
    const { transport } = renderTable(view);
    act(() => transport.serverSends('room:reaction', { roomId: ROOM_ID, playerId: 'bob', reactionId: 'clap' }));
    expect(screen.getByTestId('reaction-bubble-bob').textContent).toBe('👏');
    expect(screen.queryByTestId('reaction-button')).toBeNull();
  });
});
