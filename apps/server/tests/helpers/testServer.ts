import type { AddressInfo } from 'node:net';
import type {
  ClientToServerEvents,
  ErrorPayload,
  GameOverPayload,
  GameStatePayload,
  RestartVoteEndedPayload,
  RoomStatePayload,
  ServerToClientEvents,
  SessionIssuedPayload,
} from '@durak/shared';
import { io as connectClient, type Socket } from 'socket.io-client';
import { buildServer, type BuildServerOptions, type DurakServer } from '../../src/app.js';
import { InProcessRunner } from '../../src/bot/InProcessRunner.js';
import { UNLIMITED } from '../../src/transport/rateLimit.js';
import { FakeTime } from './fakeTime.js';
import { TEST_BOT_POLICIES } from './serviceHarness.js';

export interface ReceivedEvents {
  'room:state': RoomStatePayload;
  'game:state': GameStatePayload;
  'game:over': GameOverPayload;
  'session:issued': SessionIssuedPayload;
  'room:restartVoteEnded': RestartVoteEndedPayload;
  error: ErrorPayload;
}
export type ReceivedName = keyof ReceivedEvents;

interface Received {
  readonly event: string;
  readonly payload: unknown;
}

export class TestClient {
  readonly received: Received[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
    socket.onAny((event: string, payload: unknown) => {
      this.received.push({ event, payload });
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** Emits any event with any payload — tests deliberately bypass the typed event map. */
  send(event: string, payload?: unknown): void {
    (this.socket.emit as unknown as (ev: string, ...args: unknown[]) => void)(event, payload);
  }

  /** Index to pass as `since` so later waits ignore earlier events. */
  mark(): number {
    return this.received.length;
  }

  all<E extends ReceivedName>(event: E): ReceivedEvents[E][] {
    return this.received.filter((r) => r.event === event).map((r) => r.payload as ReceivedEvents[E]);
  }

  last<E extends ReceivedName>(event: E): ReceivedEvents[E] | undefined {
    const list = this.all(event);
    return list[list.length - 1];
  }

  /** Resolves with the first matching event at index >= since (including already-received ones). */
  waitFor<E extends ReceivedName>(
    event: E,
    predicate: (payload: ReceivedEvents[E]) => boolean = () => true,
    since = 0,
    timeoutMs = 5000,
  ): Promise<ReceivedEvents[E]> {
    const find = () => {
      for (let i = since; i < this.received.length; i++) {
        const r = this.received[i]!;
        if (r.event === event && predicate(r.payload as ReceivedEvents[E])) return r.payload as ReceivedEvents[E];
      }
      return undefined;
    };
    const found = find();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      const check = () => {
        const hit = find();
        if (hit !== undefined) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve(hit);
        }
      };
      this.listeners.add(check);
    });
  }

  waitForDisconnect(timeoutMs = 5000): Promise<void> {
    if (this.socket.disconnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for disconnect')), timeoutMs);
      this.socket.once('disconnect', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface TestHarness {
  readonly server: DurakServer;
  readonly url: string;
  /** Fake clock + scheduler driving every server timer: nothing fires until the test advances it. */
  readonly time: FakeTime;
  /** Rejects with the server's connect_error (e.g. TOO_MANY_CONNECTIONS). */
  connect(extraHeaders?: Record<string, string>): Promise<TestClient>;
  close(): Promise<void>;
}

export async function startTestServer(
  options: BuildServerOptions & { readonly time?: FakeTime } = {},
): Promise<TestHarness> {
  const { time = new FakeTime(), ...rest } = options;
  let botSeed = 1;
  const server = buildServer({
    seedSource: () => 20251112,
    clock: time,
    scheduler: time,
    // Deterministic bots: synchronous in-process decisions, small budgets, fixed pacing.
    botRunner: new InProcessRunner({ recordJobs: true }),
    // Tests drive many events without advancing the fake clock; limit tests pass their own.
    limits: UNLIMITED,
    ...rest,
    botSettings: {
      policies: TEST_BOT_POLICIES,
      random: () => 0.5,
      seedSource: () => botSeed++,
      ...rest.botSettings,
    },
  });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: TestClient[] = [];

  return {
    server,
    url,
    time,
    async connect(extraHeaders?: Record<string, string>) {
      const socket: Socket<ServerToClientEvents, ClientToServerEvents> = connectClient(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...(extraHeaders ? { extraHeaders } : {}),
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      const client = new TestClient(socket);
      clients.push(client);
      return client;
    },
    async close() {
      // Server first: its shutdown flag keeps our own disconnects from starting graces.
      await server.app.close();
      for (const c of clients) c.socket.disconnect();
    },
  };
}

/** Creates a room with `host`, seats `guests`, and returns the room id and each player's session. */
export async function setupRoom(
  host: TestClient,
  guests: TestClient[],
  maxPlayers = 2,
  config: Record<string, unknown> = {},
): Promise<{ roomId: string; sessions: SessionIssuedPayload[] }> {
  host.send('room:create', { nickname: 'host', maxPlayers, config });
  const hostSession = await host.waitFor('session:issued');
  const sessions = [hostSession];
  for (const [i, guest] of guests.entries()) {
    guest.send('room:join', { roomId: hostSession.roomId, nickname: `guest${i}` });
    sessions.push(await guest.waitFor('session:issued'));
  }
  return { roomId: hostSession.roomId, sessions };
}

/** Starts the game and waits until every client has the version-0 state. */
export async function startGame(host: TestClient, players: TestClient[], roomId: string): Promise<void> {
  host.send('game:start', { roomId });
  await Promise.all(players.map((p) => p.waitFor('game:state', (s) => s.version === 0)));
}
