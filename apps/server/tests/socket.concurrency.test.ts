import type { GameState } from '@durak/game-engine';
import type { ClientMove } from '@durak/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { setupRoom, startGame, startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function cardCount(state: GameState): { total: number; unique: number } {
  const all = [
    ...state.players.flatMap((p) => p.hand),
    ...state.deck,
    ...state.discard,
    ...state.table.flatMap((p) => (p.defense ? [p.attack, p.defense] : [p.attack])),
  ];
  return { total: all.length, unique: new Set(all.map((c) => `${c.rank}${c.suit}`)).size };
}

async function openedGame() {
  harness = await startTestServer({ seedSource: () => 9001 });
  const host = await harness.connect();
  const guest = await harness.connect();
  const { roomId } = await setupRoom(host, [guest]);
  await startGame(host, [host, guest], roomId);

  const view = host.last('game:state')!.view;
  const attacker = view.attackerId === view.viewerId ? host : guest;
  const defender = attacker === host ? guest : host;
  const card = attacker.last('game:state')!.view.hand[0]!;
  attacker.send('game:move', { roomId, move: { type: 'attack', card }, expectedVersion: 0 });
  await Promise.all([host, guest].map((c) => c.waitFor('game:state', (s) => s.version === 1)));
  return { roomId, attacker, defender, server: harness.server };
}

const send = (client: TestClient, roomId: string, move: ClientMove, expectedVersion: number) =>
  client.send('game:move', { roomId, move, expectedVersion });

describe('concurrent moves', () => {
  it('two players moving on the same version: exactly one wins, the other gets STALE_STATE + resync', async () => {
    const { roomId, attacker, defender, server } = await openedGame();
    // Both are legal at version 1; send them in the same tick.
    send(attacker, roomId, { type: 'pass' }, 1);
    send(defender, roomId, { type: 'take' }, 1);

    await Promise.all([attacker, defender].map((c) => c.waitFor('game:state', (s) => s.version === 2)));
    await new Promise((r) => setTimeout(r, 100));

    const stored = await server.repos.games.get(roomId);
    expect(stored?.version).toBe(2);
    const errors = [...attacker.all('error'), ...defender.all('error')];
    expect(errors.map((e) => e.code)).toEqual(['STALE_STATE']);
    expect(cardCount(stored!.state)).toEqual({ total: 36, unique: 36 });
  });

  it('a burst of identical moves from one player is applied exactly once', async () => {
    const { roomId, defender, server } = await openedGame();
    for (let i = 0; i < 10; i++) send(defender, roomId, { type: 'take' }, 1);
    await defender.waitFor('game:state', (s) => s.version === 2);
    await new Promise((r) => setTimeout(r, 150));

    const stored = await server.repos.games.get(roomId);
    expect(stored?.version).toBe(2);
    expect(defender.all('error').map((e) => e.code)).toEqual(Array(9).fill('STALE_STATE'));
    expect(cardCount(stored!.state)).toEqual({ total: 36, unique: 36 });
  });
});

describe('stale expectedVersion', () => {
  it('is rejected with STALE_STATE and the player immediately receives the current game:state', async () => {
    const { roomId, defender, server } = await openedGame();
    const since = defender.mark();
    send(defender, roomId, { type: 'take' }, 99);
    expect((await defender.waitFor('error', () => true, since)).code).toBe('STALE_STATE');
    const resync = await defender.waitFor('game:state', () => true, since);
    expect(resync.version).toBe(1);
    expect((await server.repos.games.get(roomId))?.version).toBe(1);
  });
});
