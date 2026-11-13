import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { c, makeView, renderTable, ROOM_ID } from './helpers';

function handCard(id: string): HTMLElement {
  const el = within(screen.getByTestId('hand'))
    .getAllByRole('button')
    .find((b) => b.dataset.card === id);
  if (!el) throw new Error(`no hand card ${id}`);
  return el;
}

function handStates(): Record<string, string | undefined> {
  return Object.fromEntries(
    within(screen.getByTestId('hand'))
      .getAllByRole('button')
      .map((b) => [b.dataset.card, b.dataset.state]),
  );
}

function attackCard(index: number): HTMLElement {
  return within(screen.getByTestId(`pair-${index}`)).getAllByRole('button')[0]!;
}

// Trump is diamonds in every view below (default trump card 6D).
const defending = (hand: string, extra: Parameters<typeof makeView>[0] = {}) =>
  makeView({ hand, attacker: 'bob', defender: 'me', counts: { bob: 6, me: 6 }, table: [['8S', null]], ...extra });

describe('legal-move highlighting', () => {
  it('the opening attacker may play every card', () => {
    renderTable(makeView({ hand: '6S 9C' }));
    expect(handStates()).toEqual({ '6S': 'playable', '9C': 'playable' });
  });

  it('a throw-in must match a rank on the table', () => {
    renderTable(makeView({ hand: '6H 9C', table: [['6S', null]] }));
    expect(handStates()).toEqual({ '6H': 'playable', '9C': 'dimmed' });
  });

  it('no throw-in beyond the defender hand size', () => {
    renderTable(makeView({ hand: '6H 9C', table: [['6S', null]], counts: { me: 6, bob: 1 } }));
    expect(handStates()).toEqual({ '6H': 'dimmed', '9C': 'dimmed' });
  });

  it('the defender sees only cards that beat an uncovered attack card', () => {
    renderTable(defending('9S 7S 6D 10H'));
    // Sorted: spades, hearts, trumps last.
    expect(handStates()).toEqual({ '7S': 'dimmed', '9S': 'playable', '10H': 'dimmed', '6D': 'playable' });
  });

  it('a transfer card is playable in perevodnoy', () => {
    renderTable(defending('8H 7C', { config: { mode: 'perevodnoy' } }));
    expect(handStates()).toEqual({ '7C': 'dimmed', '8H': 'playable' });
  });

  it('nothing is playable when it is not my turn', () => {
    renderTable(makeView({ hand: '6S 9C', attacker: 'bob', defender: 'me', counts: { bob: 6, me: 6 } }));
    expect(handStates()).toEqual({ '6S': 'dimmed', '9C': 'dimmed' });
  });
});

describe('clicking cards sends game:move with the last version', () => {
  it('attack: one click on a highlighted card', async () => {
    const { transport } = renderTable(makeView({ hand: '6S 9C' }), { version: 12 });
    await userEvent.click(handCard('9C'));
    expect(transport.emittedOf('game:move')).toEqual([
      { roomId: ROOM_ID, move: { type: 'attack', card: c('9C') }, expectedVersion: 12 },
    ]);
  });

  it('a dimmed card sends nothing', async () => {
    const { transport } = renderTable(makeView({ hand: '6H 9C', table: [['6S', null]] }));
    await userEvent.click(handCard('9C'));
    expect(transport.emittedOf('game:move')).toEqual([]);
  });

  it('defend: my card first, then the attack card it covers', async () => {
    const { transport } = renderTable(defending('9S 6D', { table: [['8S', null], ['7H', null]] }), { version: 4 });
    await userEvent.click(handCard('9S'));
    expect(handCard('9S').dataset.state).toBe('selected');
    expect(transport.emittedOf('game:move')).toEqual([]);
    // 9S beats 8S only: the 7H pair is not a target.
    expect(within(screen.getByTestId('pair-1')).queryAllByRole('button')).toEqual([]);
    await userEvent.click(attackCard(0));
    expect(transport.emittedOf('game:move')).toEqual([
      { roomId: ROOM_ID, move: { type: 'defend', attackIndex: 0, card: c('9S') }, expectedVersion: 4 },
    ]);
  });

  it('defend: the attack card first, then my card', async () => {
    const { transport } = renderTable(defending('9S 6D 7C', { table: [['8S', null], ['7H', null]] }));
    await userEvent.click(attackCard(1));
    // Only cards that beat 7H are highlighted now.
    expect(handStates()).toEqual({ '7C': 'dimmed', '9S': 'dimmed', '6D': 'playable' });
    await userEvent.click(handCard('6D'));
    expect(transport.emittedOf('game:move')).toEqual([
      { roomId: ROOM_ID, move: { type: 'defend', attackIndex: 1, card: c('6D') }, expectedVersion: 3 },
    ]);
  });

  it('clicking the selected card again cancels the selection', async () => {
    renderTable(defending('9S'));
    await userEvent.click(handCard('9S'));
    await userEvent.click(handCard('9S'));
    expect(handCard('9S').dataset.state).toBe('playable');
  });

  it('transfer: select the card, then the transfer slot', async () => {
    const { transport } = renderTable(defending('8H 9S', { config: { mode: 'perevodnoy' } }));
    expect(screen.queryByRole('button', { name: t.table.transferHere })).toBeNull();
    await userEvent.click(handCard('8H'));
    await userEvent.click(screen.getByRole('button', { name: t.table.transferHere }));
    expect(transport.emittedOf('game:move')).toEqual([
      { roomId: ROOM_ID, move: { type: 'transfer', card: c('8H') }, expectedVersion: 3 },
    ]);
  });
});

describe('Take / Pass buttons', () => {
  const take = () => screen.queryByRole('button', { name: t.table.take });
  const pass = () => screen.queryByRole('button', { name: t.table.pass });

  it('the defender sees Take (while a card is uncovered), not Pass', async () => {
    const { transport } = renderTable(defending('7C'));
    expect(take()).toBeInTheDocument();
    expect(pass()).toBeNull();
    await userEvent.click(take()!);
    expect(transport.emittedOf('game:move')).toEqual([{ roomId: ROOM_ID, move: { type: 'take' }, expectedVersion: 3 }]);
  });

  it('no Take once everything is covered or the defender is already taking', () => {
    const { unmount } = renderTable(defending('7C', { table: [['8S', '9S']] }));
    expect(take()).toBeNull();
    unmount();
    renderTable(defending('7C', { phase: { kind: 'bout', taking: true, passed: [] } }));
    expect(take()).toBeNull();
  });

  it('a non-defender in a bout sees Pass, not Take; not after passing', () => {
    const { unmount } = renderTable(makeView({ hand: '9C', table: [['6S', null]] }));
    expect(pass()).toBeInTheDocument();
    expect(take()).toBeNull();
    unmount();
    renderTable(makeView({ hand: '9C', table: [['6S', null]], phase: { kind: 'bout', taking: false, passed: ['me'] } }));
    expect(pass()).toBeNull();
  });

  it('the opening attacker sees neither', () => {
    renderTable(makeView({ hand: '9C' }));
    expect(take()).toBeNull();
    expect(pass()).toBeNull();
  });

  it('a spectator sees no hand and no buttons', () => {
    renderTable(makeView({ viewer: null, table: [['6S', null]] }));
    expect(screen.queryByTestId('hand')).toBeNull();
    expect(take()).toBeNull();
    expect(pass()).toBeNull();
    expect(screen.getByText(t.table.spectating)).toBeInTheDocument();
  });
});

describe('countdown on the table', () => {
  it('shows seconds left from turnDeadline - serverTime', () => {
    const { transport } = renderTable(makeView({ hand: '9C' }));
    expect(screen.queryByTestId('countdown')).toBeNull();
    // The fake client clock is fixed at 1000 (= receivedAt), so remaining = 25000 - 4000.
    transport.serverSends('game:state', {
      roomId: ROOM_ID,
      version: 4,
      view: makeView({ hand: '9C' }),
      turnDeadline: 25_000,
      serverTime: 4_000,
    });
    return screen.findByText(t.table.secondsLeft(21));
  });
});
