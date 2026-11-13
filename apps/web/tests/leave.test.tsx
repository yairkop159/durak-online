import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { leaveOutcome } from '../src/game/departure';
import { t } from '../src/i18n';
import { makeView, renderTable, ROOM_ID, roomState } from './helpers';

const leaveButton = () => screen.getByRole('button', { name: t.table.leave });

describe('leaving mid-game', () => {
  it('2 players: the confirm says the game will end; confirming emits room:leave and goes home', async () => {
    const user = userEvent.setup();
    const { transport } = renderTable(makeView({ hand: '6S' }));
    await user.click(leaveButton());

    expect(screen.getByRole('dialog', { name: t.table.leaveConfirm.title })).toBeInTheDocument();
    expect(screen.getByTestId('confirm-body')).toHaveTextContent(t.table.leaveConfirm.resign);
    await user.click(screen.getByRole('button', { name: t.table.leaveConfirm.confirm }));

    expect(transport.emittedOf('room:leave')).toEqual([{ roomId: ROOM_ID }]);
    expect(window.location.pathname).toBe('/');
  });

  it('3 players with another human still in: the confirm says a bot will take over', async () => {
    const user = userEvent.setup();
    renderTable(makeView({ hand: '6S', counts: { me: 6, bob: 6, ann: 6 } }));
    await user.click(leaveButton());
    expect(screen.getByTestId('confirm-body')).toHaveTextContent(t.table.leaveConfirm.takeover);
  });

  it('cancel keeps the seat: nothing is sent', async () => {
    const user = userEvent.setup();
    const { transport } = renderTable(makeView({ hand: '6S' }));
    await user.click(leaveButton());
    await user.click(screen.getByRole('button', { name: t.common.cancel }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(transport.emittedOf('room:leave')).toEqual([]);
    expect(window.location.pathname).toBe(`/room/${ROOM_ID}`);
  });

  it('a seat whose human left shows the "left" pill next to the bot pill', () => {
    const { transport } = renderTable(makeView({ hand: '6S', counts: { me: 6, bob: 6, ann: 6 } }));
    const room = roomState('playing', ['me', 'bob', 'ann']);
    act(() =>
      transport.serverSends('room:state', {
        ...room,
        members: room.members.map((m) =>
          m.playerId === 'ann' ? { ...m, isBot: true, botDifficulty: 'medium' as const, leftGame: true } : m,
        ),
      }),
    );
    const seat = screen.getByTestId('seat-ann');
    expect(seat).toHaveTextContent(t.table.left);
    expect(seat).toHaveTextContent('ANN');
  });
});

describe('leaveOutcome (same rule as the server)', () => {
  const members = roomState('playing', ['me', 'bob', 'ann']).members;
  it('takeover only while another human is still in; none once I am out', () => {
    const three = makeView({ counts: { me: 6, bob: 6, ann: 6 } });
    expect(leaveOutcome(three, members)).toBe('takeover');
    const botsOnly = members.map((m) => (m.playerId === 'me' ? m : { ...m, isBot: true }));
    expect(leaveOutcome(three, botsOnly)).toBe('resign');
    expect(leaveOutcome(makeView({ counts: { me: 0, bob: 6, ann: 6 }, finished: ['me'] }), members)).toBe('none');
  });
});
