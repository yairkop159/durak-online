import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { t } from '../src/i18n';
import { GameClient, STALE_SOCKET_AFTER_MS } from '../src/net/client';
import { MemoryStorage } from '../src/net/sessionStore';
import { watchForeground, type ForegroundEnv } from '../src/phone/foreground';
import { VIBRATION_PATTERNS, createVibrator, type HapticCue, type Vibrator } from '../src/phone/vibrate';
import { createWakeLock, type VisibilityDocument, type WakeLockSentinelLike } from '../src/phone/wakeLock';
import { PrefsProvider } from '../src/settings/react';
import { DEFAULT_SETTINGS, SettingsStore, parseSettings } from '../src/settings/settings';
import { FakeTransport, gameState, makeView, renderTable, ROOM_ID } from './helpers';

const flush = () => act(async () => {});

class FakeDoc implements VisibilityDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', l: () => void) {
    this.listeners.add(l);
  }
  removeEventListener(_type: 'visibilitychange', l: () => void) {
    this.listeners.delete(l);
  }
  get listenerCount() {
    return this.listeners.size;
  }
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    for (const l of [...this.listeners]) l();
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private onRelease: (() => void)[] = [];
  release = vi.fn(async () => {
    this.drop();
  });
  addEventListener(_type: 'release', l: () => void) {
    this.onRelease.push(l);
  }
  /** What the browser does when the page is hidden. */
  drop() {
    if (this.released) return;
    this.released = true;
    for (const l of this.onRelease) l();
  }
}

function fakeWakeLockApi(fail = false) {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async () => {
    if (fail) throw new DOMException('low battery', 'NotAllowedError');
    const s = new FakeSentinel();
    sentinels.push(s);
    return s;
  });
  return { api: { wakeLock: { request } }, request, sentinels };
}

describe('screen wake lock', () => {
  it('acquires while active and visible, releases when inactive', async () => {
    const doc = new FakeDoc();
    const { api, request, sentinels } = fakeWakeLockApi();
    const lock = createWakeLock(api, doc);
    expect(lock.supported).toBe(true);
    lock.setActive(true);
    await flush();
    expect(request).toHaveBeenCalledWith('screen');
    expect(lock.held()).toBe(true);
    lock.setActive(false);
    expect(sentinels[0]!.release).toHaveBeenCalled();
    expect(lock.held()).toBe(false);
  });

  it('the browser drops it when hidden; it is taken again when visible (only while still wanted)', async () => {
    const doc = new FakeDoc();
    const { api, request, sentinels } = fakeWakeLockApi();
    const lock = createWakeLock(api, doc);
    lock.setActive(true);
    await flush();
    doc.set('hidden');
    sentinels[0]!.drop();
    expect(lock.held()).toBe(false);
    doc.set('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held()).toBe(true);

    lock.setActive(false); // the game ended
    doc.set('hidden');
    doc.set('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('not requested while hidden; requested once the page shows', async () => {
    const doc = new FakeDoc();
    doc.visibilityState = 'hidden';
    const { api, request } = fakeWakeLockApi();
    const lock = createWakeLock(api, doc);
    lock.setActive(true);
    await flush();
    expect(request).not.toHaveBeenCalled();
    doc.set('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a lock granted after the game already ended is given back at once', async () => {
    const doc = new FakeDoc();
    const { api, sentinels } = fakeWakeLockApi();
    const lock = createWakeLock(api, doc);
    lock.setActive(true);
    lock.setActive(false); // before the request resolved
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalled();
    expect(lock.held()).toBe(false);
  });

  it('a refused request is swallowed; dispose releases and stops listening', async () => {
    const doc = new FakeDoc();
    const refused = fakeWakeLockApi(true);
    const lock = createWakeLock(refused.api, doc);
    lock.setActive(true);
    await flush();
    expect(lock.held()).toBe(false);

    const { api, sentinels } = fakeWakeLockApi();
    const other = createWakeLock(api, doc);
    other.setActive(true);
    await flush();
    other.dispose();
    expect(sentinels[0]!.release).toHaveBeenCalled();
    lock.dispose();
    expect(doc.listenerCount).toBe(0);
  });

  it('is a no-op without the API (http on a LAN IP, older browsers)', () => {
    const doc = new FakeDoc();
    const lock = createWakeLock({}, doc);
    expect(lock.supported).toBe(false);
    expect(() => lock.setActive(true)).not.toThrow();
    expect(doc.listenerCount).toBe(0);
  });

  it('the table holds it while the game runs and gives it back when it ends', async () => {
    const { api, request, sentinels } = fakeWakeLockApi();
    Object.defineProperty(navigator, 'wakeLock', { value: api.wakeLock, configurable: true });
    try {
      const { transport } = renderTable(makeView({ hand: '7H', attacker: 'me', defender: 'bob' }));
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
      const finished = makeView({ counts: { me: 0, bob: 4 }, finished: ['me'], phase: { kind: 'finished', durak: 'bob' }, deckCount: 0 });
      act(() => transport.serverSends('game:state', gameState(finished, 4)));
      await flush();
      expect(sentinels[0]!.release).toHaveBeenCalled();
    } finally {
      delete (navigator as { wakeLock?: unknown }).wakeLock;
    }
  });
});

describe('vibration', () => {
  it('vibrates the cue pattern where supported, never throws, no-op elsewhere', () => {
    const vibrate = vi.fn(() => true);
    const v = createVibrator({ vibrate });
    expect(v.supported).toBe(true);
    v.vibrate('durak');
    expect(vibrate).toHaveBeenCalledWith([...VIBRATION_PATTERNS.durak]);

    const throwing = createVibrator({
      vibrate: () => {
        throw new Error('no user activation');
      },
    });
    expect(() => throwing.vibrate('win')).not.toThrow();

    const none = createVibrator({});
    expect(none.supported).toBe(false);
    expect(() => none.vibrate('yourTurn')).not.toThrow();
    expect(createVibrator(undefined).supported).toBe(false);
  });

  it('settings v3: "vibration" defaults to on, older data migrates, bad values fall back', () => {
    expect(DEFAULT_SETTINGS.vibration).toBe(true);
    expect(parseSettings(JSON.stringify({ v: 2, showReactions: false }))).toMatchObject({ v: 3, showReactions: false, vibration: true });
    expect(parseSettings(JSON.stringify({ v: 3, vibration: false })).vibration).toBe(false);
    expect(parseSettings(JSON.stringify({ v: 3, vibration: 'no' })).vibration).toBe(true);
  });

  it('the settings switch exists only where the phone can vibrate', () => {
    const store = new SettingsStore(new MemoryStorage());
    const { unmount } = render(
      <PrefsProvider settings={store} vibrator={createVibrator({})}>
        <SettingsDialog onClose={() => {}} />
      </PrefsProvider>,
    );
    expect(screen.queryByRole('switch', { name: t.settings.vibration })).toBeNull();
    unmount();
    render(
      <PrefsProvider settings={store} vibrator={createVibrator({ vibrate: () => true })}>
        <SettingsDialog onClose={() => {}} />
      </PrefsProvider>,
    );
    fireEvent.click(screen.getByRole('switch', { name: t.settings.vibration }));
    expect(store.get().vibration).toBe(false);
  });
});

function recordingVibrator(): Vibrator & { cues: HapticCue[] } {
  const cues: HapticCue[] = [];
  return { supported: true, cues, vibrate: (cue) => cues.push(cue) };
}

const notMyTurn = () => makeView({ hand: '7H 8C', attacker: 'bob', defender: 'me' }); // awaiting bob's attack
const myTurn = () => makeView({ hand: '7H 8C', attacker: 'me', defender: 'bob' });

describe('vibration on the table', () => {
  afterEach(() => window.localStorage.clear());

  it('buzzes when it becomes my turn (once), not while it stays my turn', () => {
    const vibrator = recordingVibrator();
    const { transport } = renderTable(notMyTurn(), { vibrator });
    expect(vibrator.cues).toEqual([]);
    act(() => transport.serverSends('game:state', gameState(myTurn(), 4)));
    expect(vibrator.cues).toEqual(['yourTurn']);
    act(() => transport.serverSends('game:state', gameState(myTurn(), 5)));
    expect(vibrator.cues).toEqual(['yourTurn']);
  });

  it('never with the setting off, never for a hidden page', () => {
    window.localStorage.setItem('durak:settings', JSON.stringify({ v: 3, vibration: false }));
    const off = recordingVibrator();
    const first = renderTable(notMyTurn(), { vibrator: off });
    act(() => first.transport.serverSends('game:state', gameState(myTurn(), 4)));
    expect(off.cues).toEqual([]);
    first.unmount();
    window.localStorage.clear();

    const hidden = recordingVibrator();
    const second = renderTable(notMyTurn(), { vibrator: hidden });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => second.transport.serverSends('game:state', gameState(myTurn(), 4)));
    visibility.mockRestore();
    expect(hidden.cues).toEqual([]);
  });

  it('never for a spectator', () => {
    const vibrator = recordingVibrator();
    const { transport } = renderTable(makeView({ viewer: null, attacker: 'bob', defender: 'me' }), { vibrator });
    act(() => transport.serverSends('game:state', gameState(makeView({ viewer: null, attacker: 'me', defender: 'bob' }), 4)));
    expect(vibrator.cues).toEqual([]);
  });

  it('the game end buzzes with the reveal stamp: "durak" for the durak', async () => {
    const vibrator = recordingVibrator();
    const { transport } = renderTable(notMyTurn(), { vibrator });
    const finished = makeView({ counts: { me: 3, bob: 0 }, finished: ['bob'], phase: { kind: 'finished', durak: 'me' }, deckCount: 0 });
    act(() => {
      transport.serverSends('game:state', gameState(finished, 4));
      transport.serverSends('game:over', { roomId: ROOM_ID, durakId: 'me', finishOrder: ['bob', 'me'], endReason: 'normal', botAssisted: [], forfeits: [], stats: {} });
    });
    await screen.findByTestId('durak-reveal');
    await waitFor(() => expect(vibrator.cues).toEqual(['durak']), { timeout: 5000 });
  });

  it('no game-end buzz for a restarted game', async () => {
    const vibrator = recordingVibrator();
    const { transport } = renderTable(notMyTurn(), { vibrator });
    act(() => transport.serverSends('game:over', { roomId: ROOM_ID, durakId: null, finishOrder: [], endReason: 'restarted', botAssisted: [], forfeits: [], stats: {} }));
    await flush();
    expect(vibrator.cues).toEqual([]);
  });
});

function fakeForegroundEnv() {
  const doc = new FakeDoc();
  const winListeners = new Map<string, (e: Event) => void>();
  let now = 0;
  const env: ForegroundEnv = {
    doc,
    win: {
      addEventListener: (type, l) => winListeners.set(type, l),
      removeEventListener: (type) => winListeners.delete(type),
    },
    now: () => now,
  };
  return {
    env,
    doc,
    advance: (ms: number) => (now += ms),
    fire: (type: 'pageshow' | 'online', persisted = false) => winListeners.get(type)?.({ persisted } as unknown as Event),
    winListeners,
  };
}

describe('coming back from the background', () => {
  it('reports how long the page was hidden; bfcache restores and "online" count as long gone', () => {
    const f = fakeForegroundEnv();
    const target = { resyncNow: vi.fn() };
    const stop = watchForeground(target, f.env);
    f.doc.set('hidden');
    f.advance(40_000);
    f.doc.set('visible');
    expect(target.resyncNow).toHaveBeenLastCalledWith(40_000);
    f.fire('pageshow', false);
    expect(target.resyncNow).toHaveBeenCalledTimes(1); // a normal load: nothing to do
    f.fire('pageshow', true);
    expect(target.resyncNow).toHaveBeenLastCalledWith(Number.POSITIVE_INFINITY);
    f.fire('online');
    expect(target.resyncNow).toHaveBeenCalledTimes(3);
    stop();
    expect(f.doc.listenerCount).toBe(0);
    expect(f.winListeners.size).toBe(0);
  });

  function boundClient() {
    const transport = new FakeTransport();
    const storage = new MemoryStorage();
    storage.setItem('durak:sessions', JSON.stringify({ [ROOM_ID]: 'x'.repeat(43) }));
    const client = new GameClient({ transport, storage });
    client.setRoute(ROOM_ID);
    transport.connect();
    transport.serverSends('session:issued', { sessionToken: 'x'.repeat(43), playerId: 'me', roomId: ROOM_ID });
    return { transport, client };
  }

  it('briefly hidden on a live socket: one session:resume on it (a resync, no reconnect)', () => {
    const { transport, client } = boundClient();
    const since = transport.emitted.length;
    client.resyncNow(3_000);
    client.resyncNow(3_000); // already in flight
    expect(transport.emitted.slice(since)).toEqual([{ event: 'session:resume', payload: { sessionToken: 'x'.repeat(43) } }]);
    expect(transport.reconnects).toBe(0);
    expect(client.state.bound).toBe(true); // no "reconnecting" banner
    // The answer re-sends everything; the next return may resync again.
    transport.serverSends('session:issued', { sessionToken: 'x'.repeat(43), playerId: 'me', roomId: ROOM_ID });
    client.resyncNow(3_000);
    expect(transport.emittedOf('session:resume')).toHaveLength(3); // the first resume + two resyncs
  });

  it('hidden long enough for a zombie socket: a fresh socket at once', () => {
    const { transport, client } = boundClient();
    const since = transport.emitted.length;
    client.resyncNow(STALE_SOCKET_AFTER_MS);
    expect(transport.reconnects).toBe(1);
    expect(transport.emitted.slice(since)).toEqual([]);
  });

  it('disconnected: reconnect now instead of waiting for the backoff', () => {
    const { transport, client } = boundClient();
    transport.disconnect();
    client.resyncNow(1_000);
    expect(transport.reconnects).toBe(1);
  });

  it('on Home (no room): nothing unless the socket is down', () => {
    const transport = new FakeTransport();
    const client = new GameClient({ transport, storage: new MemoryStorage() });
    transport.connect();
    client.resyncNow(60_000);
    expect(transport.reconnects).toBe(0);
    expect(transport.emitted).toEqual([]);
    transport.disconnect();
    client.resyncNow(0);
    expect(transport.reconnects).toBe(1);
  });
});
