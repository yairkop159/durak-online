import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage, type KeyValueStorage } from '../src/net/sessionStore';
import { DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY, SettingsStore } from '../src/settings/settings';
import { FakeTransport, makeView, renderTable } from './helpers';

describe('settings store', () => {
  it('starts from the defaults: sound on, music off, normal speed, tips on', () => {
    expect(new SettingsStore(new MemoryStorage()).get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ sfx: { enabled: true }, music: { enabled: false }, animationSpeed: 'normal', showTips: true });
  });

  it('persists every change and reads it back', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore(storage);
    store.update((s) => ({ ...s, music: { enabled: true, volume: 0.5 }, animationSpeed: 'fast' }));
    store.markTipSeen('firstAttack');
    expect(new SettingsStore(storage).get()).toMatchObject({
      music: { enabled: true, volume: 0.5 },
      animationSpeed: 'fast',
      tipsSeen: ['firstAttack'],
    });
  });

  it('corrupt or partial data falls back field by field', () => {
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('[1,2]')).toEqual(DEFAULT_SETTINGS);
    expect(
      parseSettings(JSON.stringify({ sfx: { enabled: false, volume: 7 }, animationSpeed: 'warp', tipsSeen: ['firstDefense', 'bogus'] })),
    ).toEqual({ ...DEFAULT_SETTINGS, sfx: { enabled: false, volume: 1 }, tipsSeen: ['firstDefense'] });
  });

  it('works without storage, and when storage throws', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    for (const storage of [null, throwing]) {
      const store = new SettingsStore(storage);
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
      store.update((s) => ({ ...s, showTips: false }));
      expect(store.get().showTips).toBe(false); // kept in memory
    }
  });
});

describe('settings dialog', () => {
  function renderHome() {
    window.history.replaceState(null, '', '/');
    const transport = new FakeTransport();
    const client = new GameClient({ transport, storage: new MemoryStorage(), now: () => 1_000 });
    render(
      <ClientProvider client={client}>
        <App />
      </ClientProvider>,
    );
    act(() => transport.connect());
  }

  it('opens from the gear on Home and saves changes to localStorage', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: t.settings.title }));
    const dialog = screen.getByRole('dialog', { name: t.settings.title });

    await user.click(within(dialog).getByRole('switch', { name: t.settings.sfx }));
    await user.click(within(dialog).getByRole('switch', { name: t.settings.music }));
    await user.click(within(dialog).getByRole('radio', { name: t.settings.speeds.fast }));
    expect(within(dialog).getByRole('slider', { name: t.settings.sfxVolume })).toBeDisabled();

    expect(parseSettings(window.localStorage.getItem(SETTINGS_KEY))).toMatchObject({
      sfx: { enabled: false },
      music: { enabled: true },
      animationSpeed: 'fast',
    });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is also reachable in-game from the top bar', async () => {
    const user = userEvent.setup();
    renderTable(makeView({ hand: '6S' }));
    await user.click(within(screen.getByTestId('top-bar')).getByRole('button', { name: t.settings.title }));
    expect(screen.getByRole('dialog', { name: t.settings.title })).toBeInTheDocument();
  });
});
