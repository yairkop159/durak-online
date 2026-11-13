import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { SETTINGS_KEY, parseSettings } from '../src/settings/settings';
import { tipFor } from '../src/tips/tips';
import { FakeTransport, makeView, renderTable, ROOM_ID } from './helpers';

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage(), now: () => 1_000 });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => transport.connect());
  return transport;
}

describe('rules and interface guide', () => {
  it('/rules shows the rules with real cards, and the guide tab; Home links to it', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('link', { name: t.help.title }));
    expect(window.location.pathname).toBe('/rules');

    expect(screen.getByRole('heading', { level: 1, name: t.help.title })).toBeInTheDocument();
    for (const section of t.help.rules) expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
    // Examples are drawn with the game's card components (no images).
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(t.help.examples.trumpBeats, { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: t.help.tabs.guide }));
    for (const section of t.help.guide) expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
  });

  it('in-game "?" opens the same content in a dialog without leaving the room', async () => {
    const user = userEvent.setup();
    const { transport } = renderTable(makeView({ hand: '6S' }));
    const before = transport.emitted.length;
    await user.click(within(screen.getByTestId('top-bar')).getByRole('button', { name: t.help.title }));

    const dialog = screen.getByRole('dialog', { name: t.help.title });
    expect(within(dialog).getByRole('tab', { name: t.help.tabs.rules })).toHaveAttribute('aria-selected', 'true');
    expect(window.location.pathname).toBe(`/room/${ROOM_ID}`);
    expect(transport.emitted.length).toBe(before);
  });
});

describe('first-game tips', () => {
  it('tipFor: attack, defense, throw-in and transfer, each until seen', () => {
    const attack = makeView({ hand: '6S' });
    const attackMoves = [{ type: 'attack' as const, card: { rank: 6 as const, suit: 'S' as const } }];
    expect(tipFor(attack, attackMoves, [])).toBe('firstAttack');
    expect(tipFor(attack, attackMoves, ['firstAttack'])).toBeNull();

    const throwIn = makeView({ hand: '8H', table: [['8S', null]] });
    expect(tipFor(throwIn, [{ type: 'attack', card: { rank: 8, suit: 'H' } }, { type: 'pass' }], [])).toBe('firstThrowIn');

    const defending = makeView({ hand: '9S', attacker: 'bob', defender: 'me', counts: { bob: 6, me: 6 }, table: [['8S', null]] });
    const defend = { type: 'defend' as const, attackIndex: 0, card: { rank: 9 as const, suit: 'S' as const } };
    expect(tipFor(defending, [defend, { type: 'take' }], [])).toBe('firstDefense');
    expect(tipFor(defending, [defend, { type: 'transfer', card: { rank: 8, suit: 'H' } }], [])).toBe('firstTransfer');

    expect(tipFor(makeView({ viewer: null }), attackMoves, [])).toBeNull();
  });

  it('shows the tip on the table; dismissing it is remembered across reloads (localStorage)', async () => {
    const user = userEvent.setup();
    const first = renderTable(makeView({ hand: '6S 9C' }));
    expect(screen.getByTestId('tip')).toHaveTextContent(t.tips.firstAttack);
    await user.click(screen.getByRole('button', { name: t.tips.dismiss }));
    expect(screen.queryByTestId('tip')).not.toBeInTheDocument();
    expect(parseSettings(window.localStorage.getItem(SETTINGS_KEY)).tipsSeen).toEqual(['firstAttack']);

    first.unmount();
    renderTable(makeView({ hand: '6S 9C' }));
    expect(screen.queryByTestId('tip')).not.toBeInTheDocument();
  });

  it('making the move also counts; "show tips" off hides them', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTable(makeView({ hand: '6S 9C' }));
    await user.click(within(screen.getByTestId('hand')).getAllByRole('button')[0]!);
    expect(parseSettings(window.localStorage.getItem(SETTINGS_KEY)).tipsSeen).toEqual(['firstAttack']);
    unmount();

    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ showTips: false }));
    renderTable(makeView({ hand: '8H', table: [['8S', null]] }));
    expect(screen.queryByTestId('tip')).not.toBeInTheDocument();
  });
});
