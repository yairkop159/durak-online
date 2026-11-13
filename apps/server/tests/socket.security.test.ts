import type { GameState } from '@durak/game-engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredGame } from '../src/domain/types.js';
import { createInMemoryRepositories } from '../src/repositories/inMemory/index.js';
import type { Repositories } from '../src/repositories/interfaces.js';
import { autoPlay } from './helpers/autoPlay.js';
import { setupRoom, startGame, startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function expectInvalid(client: TestClient, event: string, payload: unknown): Promise<void> {
  const since = client.mark();
  client.send(event, payload);
  const error = await client.waitFor('error', () => true, since);
  expect(error.code, `${event} ${JSON.stringify(payload)}`).toBe('INVALID_PAYLOAD');
}

describe('payload validation', () => {
  it('rejects malformed payloads with an error event and keeps serving', async () => {
    harness = await startTestServer();
    const client = await harness.connect();

    await expectInvalid(client, 'room:create', 'junk');
    await expectInvalid(client, 'room:create', null);
    await expectInvalid(client, 'room:create', undefined);
    await expectInvalid(client, 'room:create', { nickname: 5, maxPlayers: 2 });
    await expectInvalid(client, 'room:create', { nickname: 'a', maxPlayers: 9 });
    await expectInvalid(client, 'room:create', { nickname: 'a', maxPlayers: 2, config: { mode: 'chess' } });
    await expectInvalid(client, 'room:join', { roomId: '../../etc', nickname: 'a' });
    await expectInvalid(client, 'game:move', { roomId: 'abcd1234', move: { type: 'pass' } }); // no expectedVersion
    await expectInvalid(client, 'game:move', {
      roomId: 'abcd1234',
      move: { type: 'take', playerId: 'someone-else' },
      expectedVersion: 0,
    });
    await expectInvalid(client, 'game:move', {
      roomId: 'abcd1234',
      move: { type: 'attack', card: { suit: 'S', rank: 5 } },
      expectedVersion: 0,
    });
    await expectInvalid(client, 'session:resume', { sessionToken: 'short' });
    await expectInvalid(client, 'not:an:event', {});

    // Still alive and serving the same connection.
    const since = client.mark();
    client.send('room:create', { nickname: 'ok', maxPlayers: 2 });
    await client.waitFor('session:issued', () => true, since);
  });

  it('drops a connection that sends more than 16 KB in one message; the server keeps running', async () => {
    harness = await startTestServer();
    const client = await harness.connect();
    client.send('room:create', { nickname: 'x'.repeat(20_000), maxPlayers: 2 });
    await client.waitForDisconnect();

    const fresh = await harness.connect();
    fresh.send('room:create', { nickname: 'ok', maxPlayers: 2 });
    await fresh.waitFor('session:issued');
  });
});

describe('a player cannot act for another player', () => {
  it('a connection without a session cannot move', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);

    const stranger = await harness.connect();
    stranger.send('game:move', { roomId, move: { type: 'pass' }, expectedVersion: 0 });
    expect((await stranger.waitFor('error')).code).toBe('NOT_IN_ROOM');
  });

  it('a player of room A cannot move in room B', async () => {
    harness = await startTestServer();
    const [a1, a2, b1, b2] = [await harness.connect(), await harness.connect(), await harness.connect(), await harness.connect()];
    await setupRoom(a1, [a2]);
    const { roomId: roomB } = await setupRoom(b1, [b2]);
    await startGame(b1, [b1, b2], roomB);

    a1.send('game:move', { roomId: roomB, move: { type: 'pass' }, expectedVersion: 0 });
    expect((await a1.waitFor('error')).code).toBe('NOT_IN_ROOM');
    expect((await harness.server.repos.games.get(roomB))?.version).toBe(0);
  });

  it('moves are always attributed to the session player: the non-attacker cannot open', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    await startGame(host, [host, guest], roomId);

    const hostView = host.last('game:state')!.view;
    const [notAttacker] = hostView.attackerId === hostView.viewerId ? [guest] : [host];
    const card = notAttacker.last('game:state')!.view.hand[0]!;
    notAttacker.send('game:move', { roomId, move: { type: 'attack', card }, expectedVersion: 0 });
    expect((await notAttacker.waitFor('error')).code).toBe('NOT_YOUR_TURN');
    expect((await harness.server.repos.games.get(roomId))?.version).toBe(0);
  });

  it('only the host can start the game', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId } = await setupRoom(host, [guest]);
    guest.send('game:start', { roomId });
    expect((await guest.waitFor('error')).code).toBe('NOT_HOST');
  });
});

/**
 * Wraps the in-memory repositories and records a snapshot of the authoritative state for
 * every saved version — through both games.save and atomic.saveRoomAndGame.
 */
function recordingRepositories(): { repos: Repositories; snapshots: Map<number, GameState> } {
  const base = createInMemoryRepositories();
  const snapshots = new Map<number, GameState>();
  const record = (game: StoredGame) => snapshots.set(game.version, structuredClone(game.state));
  return {
    snapshots,
    repos: {
      ...base,
      games: {
        get: (roomId) => base.games.get(roomId),
        delete: (roomId) => base.games.delete(roomId),
        save: async (game) => {
          record(game);
          await base.games.save(game);
        },
      },
      atomic: {
        deleteRoomAndGame: (roomId) => base.atomic.deleteRoomAndGame(roomId),
        saveRoomDeleteGame: (room) => base.atomic.saveRoomDeleteGame(room),
        saveRoomAndGame: async (room, game) => {
          record(game);
          await base.atomic.saveRoomAndGame(room, game);
        },
      },
    },
  };
}

describe('hand privacy', () => {
  it('no game:state payload ever contains an opponent card or the stock order', async () => {
    const { repos, snapshots } = recordingRepositories();
    const games = { snapshots };
    harness = await startTestServer({ repos, seedSource: () => 4242 });
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [guest]);
    for (const c of [host, guest]) autoPlay(c, roomId);
    const watcher = await harness.connect();
    host.send('game:start', { roomId });
    await host.waitFor('game:state');
    watcher.send('room:join', { roomId, nickname: 'watcher' });
    await Promise.all([host, guest].map((c) => c.waitFor('game:over', () => true, 0, 15_000)));

    const serialized = (card: { suit: string; rank: number }) => JSON.stringify({ suit: card.suit, rank: card.rank });
    const check = (client: TestClient, viewerId: string | null) => {
      const states = client.all('game:state');
      expect(states.length).toBeGreaterThan(0);
      for (const payload of states) {
        const snapshot = games.snapshots.get(payload.version);
        expect(snapshot, `snapshot for version ${payload.version}`).toBeDefined();
        const json = JSON.stringify(payload);
        const hidden = [
          ...snapshot!.players.filter((p) => p.id !== viewerId).flatMap((p) => p.hand),
          ...snapshot!.deck,
          ...snapshot!.discard,
        ].filter((c) => !(c.suit === snapshot!.trumpCard.suit && c.rank === snapshot!.trumpCard.rank));
        for (const card of hidden) expect(json).not.toContain(serialized(card));
        expect(Object.keys(payload.view)).not.toContain('deck');
        expect(Object.keys(payload.view)).not.toContain('discard');
        for (const p of payload.view.players) expect(Object.keys(p).sort()).toEqual(['finished', 'handCount', 'id']);
      }
    };
    check(host, sessions[0]!.playerId);
    check(guest, sessions[1]!.playerId);
    check(watcher, null);
  });
});
