import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { initialState, reducer } from '../src/net/store';
import { gameState, makeView, renderTable, ROOM_ID, roomState } from './helpers';

const openVote = (proposerId: string, awaiting: string[], accepted: string[] = []) => ({
  ...roomState('playing', ['me', 'bob', 'ann']),
  restartVote: { voteId: 'v1', proposerId, expiresAt: 31_000, serverTime: 1_000, accepted, awaiting },
});

describe('restart vote', () => {
  it('the top-bar button asks for confirmation, then proposes', async () => {
    const user = userEvent.setup();
    const { transport } = renderTable(makeView({ hand: '6S' }));
    await user.click(screen.getByRole('button', { name: t.restart.button }));
    expect(screen.getByRole('dialog', { name: t.restart.confirmTitle })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.restart.propose }));
    expect(transport.emittedOf('room:restartPropose')).toEqual([{ roomId: ROOM_ID }]);
  });

  it('an awaited voter gets accept / decline with a countdown and answers with the vote id', async () => {
    const user = userEvent.setup();
    const { transport } = renderTable(makeView({ hand: '6S', counts: { me: 6, bob: 6, ann: 6 } }));
    act(() => transport.serverSends('room:state', openVote('bob', ['me', 'ann'])));

    const panel = screen.getByTestId('restart-vote');
    expect(panel).toHaveTextContent(t.restart.proposed('BOB'));
    expect(panel).toHaveTextContent('30');
    // A vote is open: nobody can propose another one.
    expect(screen.getByRole('button', { name: t.restart.button })).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('button', { name: t.restart.accept }));
    expect(transport.emittedOf('room:restartRespond')).toEqual([{ roomId: ROOM_ID, voteId: 'v1', accept: true }]);
  });

  it('everyone else sees how many answers are missing', () => {
    const { transport } = renderTable(makeView({ hand: '6S', counts: { me: 6, bob: 6, ann: 6 } }));
    act(() => transport.serverSends('room:state', openVote('me', ['ann'], ['bob'])));
    const panel = screen.getByTestId('restart-vote');
    expect(panel).toHaveTextContent(t.restart.youProposed);
    expect(panel).toHaveTextContent(t.restart.waiting(1, 2));
    expect(screen.queryByRole('button', { name: t.restart.accept })).not.toBeInTheDocument();
  });

  it('a toast tells everyone how the vote ended', () => {
    const { transport } = renderTable(makeView({ hand: '6S', counts: { me: 6, bob: 6, ann: 6 } }));
    act(() => transport.serverSends('room:state', roomState('playing', ['me', 'bob', 'ann'])));
    act(() =>
      transport.serverSends('room:restartVoteEnded', { roomId: ROOM_ID, voteId: 'v1', proposerId: 'me', outcome: 'declined', by: 'ann' }),
    );
    expect(screen.getByTestId('notice')).toHaveTextContent(t.restart.declined('ANN'));
  });

  it('a passed vote: game:over "restarted" shows no overlay, and the new game (version 0) replaces the old one', () => {
    const { transport } = renderTable(makeView({ hand: '6S 7S' }), { version: 9 });
    act(() => {
      transport.serverSends('game:over', { roomId: ROOM_ID, durakId: null, finishOrder: [], endReason: 'restarted', botAssisted: [], forfeits: [] });
      transport.serverSends('room:state', roomState('playing'));
      transport.serverSends('game:state', gameState(makeView({ hand: '9H' }), 0, { gameId: 'g2' }));
    });
    expect(screen.queryByTestId('game-over-headline')).not.toBeInTheDocument();
    expect(screen.getByTestId('hand').querySelectorAll('[data-card]')).toHaveLength(1);
  });
});

describe('reducer: games are identified by gameId', () => {
  it('ignores an older version of the same game but accepts version 0 of a new game', () => {
    const view = makeView();
    let s = reducer(initialState, { type: 'game:state', payload: gameState(view, 5), receivedAt: 0 });
    s = reducer(s, { type: 'game:state', payload: gameState(view, 3), receivedAt: 0 });
    expect(s.game?.version).toBe(5);
    s = reducer(s, { type: 'game:state', payload: gameState(view, 0, { gameId: 'g2' }), receivedAt: 0 });
    expect(s.game).toMatchObject({ gameId: 'g2', version: 0 });
  });
});
