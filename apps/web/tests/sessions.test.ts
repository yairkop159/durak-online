// @vitest-environment node
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { getLegalMovesForView } from '@durak/game-engine';
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

describe('automatic reconnect after a network blip, against a real server', () => {
  it('the exact incident sequence: the cut socket reconnects, resumes, and its move succeeds (no NOT_IN_ROOM)', async () => {
    const url = await startServer();
    const target = new URL(url);
    // Client A reaches the server through a TCP relay; destroying its sockets = a Wi-Fi blip.
    // socket.io then reconnects by itself, exactly as in the incident.
    const live = new Set<Socket>();
    const relay = createServer((downstream) => {
      const upstream = connect(Number(target.port), target.hostname);
      for (const s of [downstream, upstream]) {
        live.add(s);
        s.on('error', () => s.destroy());
        s.on('close', () => live.delete(s));
      }
      downstream.pipe(upstream).pipe(downstream);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    try {
      const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
      const a = newClient(relayUrl, new MemoryStorage());
      a.createRoom({ nickname: 'A', maxPlayers: 2, mode: 'podkidnoy' });
      const roomId = (await waitFor(a, (s) => s.session !== null)).session!.roomId;
      a.setRoute(roomId);
      const b = newClient(url, new MemoryStorage(), roomId);
      await waitFor(b, (s) => s.connection === 'connected');
      b.joinRoom(roomId, 'B');
      await waitFor(a, (s) => s.room?.members.length === 2);
      a.startGame();
      await waitFor(a, (s) => s.game !== null);
      await waitFor(b, (s) => s.game !== null);
      const errorsOf = (client: GameClient) => {
        const codes: string[] = [];
        client.store.subscribe(() => {
          const e = client.state.lastError;
          if (e && codes.at(-1) !== `${e.id}:${e.code}`) codes.push(`${e.id}:${e.code}`);
        });
        return codes;
      };
      const aErrors = errorsOf(a);

      // The blip.
      for (const s of [...live]) s.destroy();
      await waitFor(a, (s) => s.connection === 'disconnected');
      await waitFor(a, (s) => s.connection === 'connected');

      // As in the repro: A acts right away. Before the resume completes the move is held back,
      // not sent (it would have been NOT_IN_ROOM).
      const firstMove = (client: GameClient) => getLegalMovesForView(client.state.game!.view)[0];
      const versionBefore = a.state.game!.version;
      if (!a.state.bound && firstMove(a)) a.sendMove(firstMove(a)!);

      await waitFor(a, (s) => s.bound);
      await waitFor(b, (s) => s.room?.members.find((m) => m.nickname === 'A')?.connected === true);
      // If B must open, let it; then A moves on its re-bound socket.
      if (!firstMove(a)) {
        b.sendMove(firstMove(b)!);
        await waitFor(a, (s) => getLegalMovesForView(s.game!.view).length > 0);
      }
      const before = a.state.game!.version;
      a.sendMove(firstMove(a)!);
      await waitFor(a, (s) => s.game!.version > before);
      expect(a.state.game!.version).toBeGreaterThan(versionBefore);
      expect(aErrors.filter((e) => e.endsWith('NOT_IN_ROOM'))).toEqual([]);
      expect(a.state.lastError?.code).not.toBe('NOT_IN_ROOM');
    } finally {
      for (const s of [...live]) s.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
