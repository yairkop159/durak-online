// @vitest-environment node
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type DurakServer } from '../../server/src/app';
import { GameClient } from '../src/net/client';
import { MemoryStorage } from '../src/net/sessionStore';
import type { ClientState } from '../src/net/store';
import { socketTransport } from '../src/net/transport';

let server: DurakServer | undefined;
const clients: GameClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.app.close();
  server = undefined;
});

async function startServer(): Promise<string> {
  server = buildServer({ seedSource: () => 7 });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}

function newClient(url: string, storage: MemoryStorage, roomId: string | null = null): GameClient {
  const client = new GameClient({ transport: socketTransport(url, { websocketOnly: true }), storage });
  client.setRoute(roomId);
  clients.push(client);
  return client;
}

function waitFor(client: GameClient, predicate: (s: ClientState) => boolean, timeoutMs = 5000): Promise<ClientState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out; state: ${JSON.stringify(client.state)}`));
    }, timeoutMs);
    const unsubscribe = client.store.subscribe(() => {
      if (!predicate(client.state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(client.state);
    });
  });
}

describe('sessions are per tab (sessionStorage), against a real server', () => {
  it('two tabs of the same browser get separate seats; a reload resumes the same seat', async () => {
    const url = await startServer();
    // Two tabs = two independent sessionStorage instances.
    const tabA = new MemoryStorage();
    const tabB = new MemoryStorage();

    const host = newClient(url, tabA);
    host.createRoom({ nickname: 'Host', maxPlayers: 2, mode: 'podkidnoy' });
    const { session: hostSession } = await waitFor(host, (s) => s.session !== null);
    const roomId = hostSession!.roomId;

    const guest = newClient(url, tabB, roomId);
    await waitFor(guest, (s) => s.connection === 'connected');
    expect(guest.hasStoredSession(roomId)).toBe(false); // tab B does not see tab A's token
    guest.joinRoom(roomId, 'Guest');
    const { session: guestSession } = await waitFor(guest, (s) => s.session !== null);

    expect(guestSession!.playerId).not.toBe(hostSession!.playerId);
    const lobby = await waitFor(host, (s) => s.room?.members.length === 2);
    expect(lobby.room!.members.map((m) => m.nickname)).toEqual(['Host', 'Guest']);

    // Reload tab B: a new client on the same storage resumes the same seat automatically.
    guest.close();
    const reloaded = newClient(url, tabB, roomId);
    const { session: resumed } = await waitFor(reloaded, (s) => s.session !== null && s.room !== null);
    expect(resumed!.playerId).toBe(guestSession!.playerId);
    expect((await waitFor(host, (s) => s.room?.members.length === 2)).room!.members).toHaveLength(2);
  });
});
