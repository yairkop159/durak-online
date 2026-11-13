import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { animationFor } from '../src/anim/useBoardAnimation';
import { awaitedPlayers } from '../src/game/awaited';
import { t } from '../src/i18n';
import type { ClientGame } from '../src/net/store';
import { c, gameState, makeView, renderTable, ROOM_ID } from './helpers';

const clientGame = (version: number, view = makeView()): ClientGame => ({
  roomId: ROOM_ID,
  gameId: 'g1',
  version,
  view,
  turnDeadline: null,
  serverTime: 0,
  receivedAt: 0,
});

describe('animationFor: only consecutive versions animate', () => {
  const before = makeView({ hand: '6S 9C' });
  const after = makeView({ hand: '9C', table: [['6S', null]], counts: { me: 5, bob: 6 } });

  it('version + 1 of the same room -> events, a timeline and a reveal plan', () => {
    const anim = animationFor(clientGame(3, before), clientGame(4, after), false);
    expect(anim.events.map((e) => e.type)).toEqual(['played']);
    expect(anim.timeline.totalMs).toBeGreaterThan(0);
    // My own card glides via layoutId: nothing to hide.
    expect(anim.reveal.size).toBe(0);
  });

  it('a version gap (resync) or another room snaps', () => {
    expect(animationFor(clientGame(3, before), clientGame(5, after), false).events).toEqual([]);
    expect(animationFor({ ...clientGame(3, before), roomId: 'other' }, clientGame(4, after), false).events).toEqual([]);
    expect(animationFor(null, clientGame(4, after), false).events).toEqual([]);
  });

  it("an opponent's card is hidden until its flight lands; reduced motion fades it at once", () => {
    const opp = makeView({ hand: '9C', attacker: 'bob', defender: 'me', counts: { me: 6, bob: 6 } });
    const played = makeView({ hand: '9C', attacker: 'bob', defender: 'me', counts: { me: 6, bob: 5 }, table: [['6S', null]] });
    expect(animationFor(clientGame(3, opp), clientGame(4, played), false).reveal.get('6S')!.delayMs).toBeGreaterThan(0);
    expect(animationFor(clientGame(3, opp), clientGame(4, played), true).reveal.get('6S')).toEqual({ delayMs: 0, fadeMs: 150 });
  });
});

describe('awaitedPlayers (who gets the countdown ring)', () => {
  it('the attacker before the bout opens', () => {
    expect(awaitedPlayers(makeView({ attacker: 'bob', defender: 'me' }), [])).toEqual(new Set(['bob']));
  });

  it('the defender while a card is uncovered; me exactly from my legal moves', () => {
    const view = makeView({ table: [['6S', null]] });
    expect(awaitedPlayers(view, [])).toEqual(new Set(['bob']));
    expect(awaitedPlayers(view, [{ type: 'pass' }])).toEqual(new Set(['bob', 'me']));
  });

  it('everything covered: the non-defenders who have not passed', () => {
    const view = makeView({
      counts: { me: 4, bob: 4, carl: 4 },
      attacker: 'carl',
      defender: 'bob',
      table: [['6S', '7S']],
      phase: { kind: 'bout', taking: false, passed: ['carl'] },
    });
    expect(awaitedPlayers(view, [{ type: 'pass' }])).toEqual(new Set(['me']));
  });
});

describe('table visuals and micro-interactions', () => {
  it('role badges are labels, not buttons', () => {
    renderTable(makeView({ hand: '6S', table: [['7S', null]] }));
    const seat = screen.getByTestId('seat-bob');
    expect(within(seat).getByText(t.table.defender).closest('button')).toBeNull();
    expect(within(seat).queryAllByRole('button')).toEqual([]);
  });

  it('clicking a dimmed card shakes it and sends nothing', async () => {
    const { transport } = renderTable(makeView({ hand: '6H 9C', table: [['6S', null]] }));
    const dimmed = within(screen.getByTestId('hand'))
      .getAllByRole('button')
      .find((b) => b.dataset.card === '9C')!;
    await userEvent.click(dimmed);
    expect(dimmed.className).toContain('animate-shake');
    expect(transport.emittedOf('game:move')).toEqual([]);
    fireEvent.animationEnd(dimmed);
    expect(dimmed.className).not.toContain('animate-shake');
  });

  it("an opponent's play renders the latest state at once (animation never gates state)", () => {
    const { transport } = renderTable(makeView({ hand: '9C', attacker: 'bob', defender: 'me', counts: { me: 6, bob: 6 } }), { version: 3 });
    act(() => {
      transport.serverSends(
        'game:state',
        gameState(makeView({ hand: '9C', attacker: 'bob', defender: 'me', counts: { me: 6, bob: 5 }, table: [['6S', null]] }), 4),
      );
    });
    const card = within(screen.getByTestId('pair-0')).getByRole('img', { name: /6/ });
    expect(card.dataset.card).toBe('6S');
    // Revealed when its flight lands (CSS animation), but already in the DOM.
    expect(card.style.animation).toContain('reveal');
    // A newer state arriving mid-animation: shown immediately, no pending reveal.
    act(() => {
      transport.serverSends(
        'game:state',
        gameState(
          makeView({ hand: '9C', attacker: 'bob', defender: 'me', counts: { me: 6, bob: 4 }, table: [['6S', null], ['6H', null]] }),
          6,
        ),
      );
    });
    expect(within(screen.getByTestId('pair-0')).getByRole('img').style.animation).toBe('');
    expect(screen.getByTestId('pair-1')).toBeInTheDocument();
  });

  it('the trump card under the deck stays visible', () => {
    renderTable(makeView({ hand: '9C', trump: 'AH' }));
    expect(within(screen.getByTestId('deck')).getByRole('img').dataset.card).toBe('AH');
    expect(c('AH').suit).toBe('H');
  });
});
