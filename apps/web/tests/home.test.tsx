import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { DISABLED_BUTTON_CLASSES } from '../src/components/ui';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { FakeTransport } from './helpers';

function setup() {
  window.history.replaceState(null, '', '/');
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage() });
  render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => transport.connect());
  const nickname = screen.getByRole('textbox', { name: t.home.nickname });
  const create = screen.getByRole('button', { name: t.home.create });
  const vsComputer = screen.getByRole('button', { name: new RegExp(t.home.vsComputer) });
  return { transport, nickname, create, vsComputer };
}

describe('Home without a nickname', () => {
  it('both start buttons are disabled with the same style, and a hint explains why', () => {
    const { nickname, create, vsComputer } = setup();
    for (const button of [create, vsComputer]) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      for (const cls of DISABLED_BUTTON_CLASSES.split(' ')) expect(button.className.split(' ')).toContain(cls);
    }
    const hint = screen.getByText(t.home.nicknameRequired);
    expect(nickname).toHaveAttribute('aria-describedby', hint.id);
  });

  it('clicking either disabled button focuses the nickname field and sends nothing', async () => {
    const { transport, nickname, create, vsComputer } = setup();
    for (const button of [create, vsComputer]) {
      nickname.blur();
      expect(nickname).not.toHaveFocus();
      await userEvent.click(button);
      expect(nickname).toHaveFocus();
    }
    await userEvent.keyboard('{Enter}'); // submitting the empty form does nothing either
    expect(transport.emittedOf('room:create')).toEqual([]);
  });

  it('a whitespace-only nickname still counts as empty', async () => {
    const { nickname, create } = setup();
    await userEvent.type(nickname, '   ');
    expect(create).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(t.home.nicknameRequired)).toBeInTheDocument();
  });

  it('typing a nickname enables both buttons and removes the hint', async () => {
    const { transport, nickname, create, vsComputer } = setup();
    await userEvent.type(nickname, 'Dana');
    expect(create).toHaveAttribute('aria-disabled', 'false');
    expect(vsComputer).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText(t.home.nicknameRequired)).toBeNull();
    expect(nickname).not.toHaveAttribute('aria-describedby');
    await userEvent.click(create);
    expect(transport.emittedOf('room:create')).toHaveLength(1);
  });
});
