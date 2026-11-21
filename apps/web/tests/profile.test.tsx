import type { LeaderboardResponse, PublicProfile } from '@durak/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage, type KeyValueStorage } from '../src/net/sessionStore';
import { ProfileApi, type FetchLike } from '../src/profile/api';
import { parseProfile, PROFILE_KEY, ProfileStore } from '../src/profile/profileStore';
import { createProfiles } from '../src/profile/react';
import { formatDelta } from '../src/screens/profile/ProfileScreen';
import { FakeTransport, ROOM_ID } from './helpers';

const ID = 'p'.repeat(22);
const KEY = 'k'.repeat(43);
const OTHER = 'o'.repeat(22);

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A fake /api: `routes` maps "METHOD /path" to [status, body]. */
function fakeApi(routes: Record<string, [number, unknown] | (() => [number, unknown])>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (!route) throw new TypeError('network down');
    const [status, body] = typeof route === 'function' ? route() : route;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { api: new ProfileApi('http://srv.test', fetchImpl), calls };
}

const stored = (nickname = 'Dana') => {
  const storage = new MemoryStorage();
  storage.setItem(PROFILE_KEY, JSON.stringify({ v: 1, profileId: ID, deviceKey: KEY, nickname }));
  return storage;
};

const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  profileId: ID,
  nickname: 'Dana',
  rating: 1032,
  games: 5,
  ratedGames: 3,
  wins: 3,
  duraks: 1,
  forfeits: 0,
  tournamentsWon: 1,
  rank: 2,
  recent: [
    {
      gameId: 'g2',
      endedAt: Date.UTC(2026, 10, 14),
      mode: 'perevodnoy',
      endReason: 'normal',
      rated: true,
      result: 'win',
      ratingBefore: 1016,
      ratingAfter: 1032,
      botAssisted: false,
      others: [{ nickname: 'Avi', isBot: false, profileId: OTHER, result: 'durak' }],
    },
    {
      gameId: 'g1',
      endedAt: Date.UTC(2026, 10, 13),
      mode: 'podkidnoy',
      endReason: 'normal',
      rated: false,
      result: 'durak',
      ratingBefore: null,
      ratingAfter: null,
      botAssisted: true,
      others: [{ nickname: 'Bot 1', isBot: true, profileId: null, result: 'win' }],
    },
  ],
  ...over,
});

function renderAt(path: string, api: ProfileApi, storage: KeyValueStorage = new MemoryStorage()) {
  window.history.replaceState(null, '', path);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage(), now: () => 1_000 });
  const store = new ProfileStore(storage);
  render(
    <ClientProvider client={client}>
      <App profiles={createProfiles(store, api)} />
    </ClientProvider>,
  );
  act(() => transport.connect());
  return { transport, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfileStore', () => {
  it('parses field by field; anything malformed is "no profile"', () => {
    expect(parseProfile(JSON.stringify({ v: 1, profileId: ID, deviceKey: KEY, nickname: ' Dana ' }))).toEqual({ v: 1, profileId: ID, deviceKey: KEY, nickname: 'Dana' });
    for (const raw of [null, '', 'not json', '[]', JSON.stringify({ v: 2, profileId: ID, deviceKey: KEY, nickname: 'a' }), JSON.stringify({ v: 1, profileId: 'x', deviceKey: KEY, nickname: 'a' }), JSON.stringify({ v: 1, profileId: ID, deviceKey: KEY, nickname: '' })]) {
      expect(parseProfile(raw)).toBeNull();
    }
  });

  it('persists to localStorage and survives blocked storage', () => {
    const storage = new MemoryStorage();
    new ProfileStore(storage).set({ profileId: ID, deviceKey: KEY, nickname: 'Dana' });
    expect(new ProfileStore(storage).get()).toMatchObject({ profileId: ID, nickname: 'Dana' });
    const blocked: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = new ProfileStore(blocked);
    expect(store.get()).toBeNull();
    store.set({ profileId: ID, deviceKey: KEY, nickname: 'Dana' });
    expect(store.get()?.nickname).toBe('Dana');
  });
});

describe('ProfileApi', () => {
  it('sends the key as a bearer token and maps errors; never throws', async () => {
    const { api, calls } = fakeApi({ 'GET /profile/me': [401, { error: 'UNAUTHORIZED' }], 'GET /leaderboard': [500, 'oops'] });
    expect(await api.me(KEY)).toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/profile/me', auth: `Bearer ${KEY}` });
    expect(await api.leaderboard()).toEqual({ ok: false, error: 'NETWORK' }); // not an API error body
    expect(await api.claim('ABCD-1234')).toEqual({ ok: false, error: 'NETWORK' }); // fetch threw
  });
});

describe('createProfiles', () => {
  it('prepare() creates a profile with the placeholder nickname; seatKey then renames in the background', async () => {
    const { api, calls } = fakeApi({
      'POST /profile': [200, { profileId: ID, deviceKey: KEY, nickname: t.profile.defaultNickname }],
      'PATCH /profile/me': [200, { profileId: ID, nickname: 'Dana' }],
    });
    const store = new ProfileStore(new MemoryStorage());
    const profiles = createProfiles(store, api);
    expect(profiles.seatKey('Dana')).toBeUndefined(); // no profile yet: an unrated seat
    await profiles.prepare();
    expect(store.get()).toMatchObject({ profileId: ID, nickname: t.profile.defaultNickname });
    expect(profiles.seatKey('Dana')).toBe(KEY); // synchronous
    expect(store.get()?.nickname).toBe('Dana');
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { nickname: string }).nickname === 'Dana')).toBe(true));
  });

  it('a key revoked by a transfer elsewhere is replaced by a new profile', async () => {
    const { api } = fakeApi({
      'GET /profile/me': [401, { error: 'UNAUTHORIZED' }],
      'POST /profile': [200, { profileId: OTHER, deviceKey: 'n'.repeat(43), nickname: 'Dana' }],
    });
    const store = new ProfileStore(stored());
    await createProfiles(store, api).prepare();
    expect(store.get()).toMatchObject({ profileId: OTHER, nickname: 'Dana' });
  });

  it('offline or ratings down: nothing changes, nothing throws', async () => {
    const { api } = fakeApi({ 'GET /profile/me': [503, { error: 'RATINGS_UNAVAILABLE' }] });
    const store = new ProfileStore(stored());
    await createProfiles(store, api).prepare();
    expect(store.get()?.profileId).toBe(ID);
    const offline = new ProfileStore(new MemoryStorage());
    await createProfiles(offline, fakeApi({}).api).prepare();
    expect(offline.get()).toBeNull();
  });
});

describe('Home and the join prompt seat with the device key', () => {
  it('pre-fills the nickname and sends the key with room:create', async () => {
    const { api } = fakeApi({ 'GET /profile/me': [200, { profileId: ID, nickname: 'Dana' }] });
    const { transport } = renderAt('/', api, stored());
    expect(screen.getByRole('textbox')).toHaveValue('Dana');
    await userEvent.click(screen.getByRole('button', { name: t.home.create }));
    expect(transport.emittedOf('room:create')).toEqual([{ nickname: 'Dana', maxPlayers: 2, config: { mode: 'podkidnoy' }, deviceKey: KEY }]);
  });

  it('without a profile (offline) the seat is unrated and play is not delayed', async () => {
    const { transport } = renderAt('/', fakeApi({}).api);
    await userEvent.type(screen.getByRole('textbox'), 'Dana');
    await userEvent.click(screen.getByRole('button', { name: t.home.create }));
    expect(transport.emittedOf('room:create')).toEqual([{ nickname: 'Dana', maxPlayers: 2, config: { mode: 'podkidnoy' } }]);
  });

  it('the join prompt sends the key with room:join', async () => {
    const { api } = fakeApi({ 'GET /profile/me': [200, { profileId: ID, nickname: 'Dana' }] });
    const { transport } = renderAt(`/room/${ROOM_ID}`, api, stored());
    await userEvent.click(await screen.findByRole('button', { name: t.join.submit }));
    expect(transport.emittedOf('room:join')).toEqual([{ roomId: ROOM_ID, nickname: 'Dana', deviceKey: KEY }]);
  });

  it('the profile button and the leaderboard link open their pages', async () => {
    renderAt('/', fakeApi({}).api);
    await userEvent.click(screen.getByRole('link', { name: t.profile.title }));
    expect(window.location.pathname).toBe('/profile');
    expect(await screen.findByRole('heading', { level: 1, name: t.profile.title })).toBeInTheDocument();
  });
});

describe('/profile', () => {
  it('shows rating, rank, games, wins, durak count and the recent games with deltas', async () => {
    const { api } = fakeApi({
      'GET /profile/me': [200, { profileId: ID, nickname: 'Dana' }],
      [`GET /profile/${ID}`]: [200, profile()],
    });
    renderAt('/profile', api, stored());
    expect(await screen.findByTestId('rating')).toHaveTextContent('1032');
    expect(screen.getByText(t.profile.rank(2))).toBeInTheDocument();
    const rows = screen.getAllByTestId('recent-game');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(t.profile.results.win);
    expect(rows[0]).toHaveTextContent('+16');
    expect(rows[0]).toHaveTextContent(t.profile.vs('Avi'));
    expect(rows[1]).toHaveTextContent(t.profile.unrated);
    expect(rows[1]).toHaveTextContent(t.bots.name('1'));
    expect(rows[1]).toHaveTextContent(t.profile.botAssisted);
    expect(formatDelta(-16)).toBe('−16');
  });

  it('ratings down: a calm note, and the rest of the app works', async () => {
    const { api } = fakeApi({ [`GET /profile/${ID}`]: [503, { error: 'RATINGS_UNAVAILABLE' }] });
    renderAt('/profile', api, stored());
    expect(await screen.findByText(t.profile.unavailable)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.common.backHome }));
    expect(window.location.pathname).toBe('/');
  });

  it('transfer: shows the code with a countdown that runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = fakeApi({
      'GET /profile/me': [200, { profileId: ID, nickname: 'Dana' }],
      [`GET /profile/${ID}`]: [200, profile()],
      'POST /profile/transfer-code': [200, { code: 'ABCD1234', expiresAt: 50_000 + 600_000, serverTime: 50_000 }],
    });
    renderAt('/profile', api, stored());
    await userEvent.click(await screen.findByRole('button', { name: t.profile.transfer.button }));
    expect(await screen.findByTestId('transfer-code')).toHaveTextContent('ABCD-1234');
    expect(screen.getByText(t.profile.transfer.expiresIn('10:00'))).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(600_000 + 1000));
    expect(screen.getByText(t.profile.transfer.expired)).toBeInTheDocument();
  });

  it('claim: a valid code moves the profile here; a bad one says why', async () => {
    let attempt = 0;
    const { api } = fakeApi({
      'POST /profile/claim': () => (++attempt === 1 ? [400, { error: 'INVALID_CODE' }] : [200, { profileId: OTHER, deviceKey: 'n'.repeat(43), nickname: 'Avi' }]),
      [`GET /profile/${OTHER}`]: [200, profile({ profileId: OTHER, nickname: 'Avi' })],
    });
    const { store } = renderAt('/profile', api);
    expect(screen.getByText(t.profile.noProfile)).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: t.profile.claim.label });
    await userEvent.type(input, 'wxyz-1234');
    await userEvent.click(screen.getByRole('button', { name: t.profile.claim.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t.apiErrors.INVALID_CODE);
    await userEvent.click(screen.getByRole('button', { name: t.profile.claim.submit }));
    expect(await screen.findByText(t.profile.claim.done('Avi'))).toBeInTheDocument();
    expect(store.get()).toMatchObject({ profileId: OTHER, nickname: 'Avi' });
  });
});

describe('/leaderboard', () => {
  it('lists the top players, highlights mine and links to each profile', async () => {
    const board: LeaderboardResponse = {
      entries: [
        { rank: 1, profileId: OTHER, nickname: 'Avi', rating: 1100, ratedGames: 9, wins: 7, duraks: 1 },
        { rank: 2, profileId: ID, nickname: 'Dana', rating: 1032, ratedGames: 3, wins: 3, duraks: 1 },
      ],
    };
    const { api } = fakeApi({ 'GET /leaderboard': [200, board], [`GET /profile/${OTHER}`]: [200, profile({ profileId: OTHER, nickname: 'Avi' })] });
    renderAt('/leaderboard', api, stored());
    const list = await screen.findByRole('list', { name: t.leaderboard.title });
    const links = list.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[1]!.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(links[0]!.querySelector('[aria-current]')).toBeNull();
    await userEvent.click(links[0]!);
    expect(window.location.pathname).toBe(`/profile/${OTHER}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Avi' })).toBeInTheDocument();
    // Someone else's profile offers no transfer.
    expect(screen.queryByRole('button', { name: t.profile.transfer.button })).toBeNull();
  });

  it('ratings down: a calm note', async () => {
    renderAt('/leaderboard', fakeApi({ 'GET /leaderboard': [503, { error: 'RATINGS_UNAVAILABLE' }] }).api);
    expect(await screen.findByText(t.profile.unavailable)).toBeInTheDocument();
  });
});
