import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestHarness } from './helpers/testServer.js';

interface LogLine {
  readonly msg: string;
  readonly [key: string]: unknown;
}

let harness: TestHarness | undefined;
let raw: string[] = [];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  raw = [];
});

async function start(): Promise<TestHarness> {
  raw = [];
  harness = await startTestServer({
    logger: { level: 'info', stream: { write: (line: string) => void raw.push(line) } },
  });
  return harness;
}

const lines = (): LogLine[] => raw.map((l) => JSON.parse(l) as LogLine);
const linesWith = (msg: string) => lines().filter((l) => l.msg === msg);

async function eventually(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; log:\n${raw.join('')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('connection and error logging', () => {
  it('logs disconnects with their reason, resumes (success and failure), and every error code sent', async () => {
    const h = await start();
    const host = await h.connect();
    host.send('room:create', { nickname: 'Host', maxPlayers: 2, config: { mode: 'podkidnoy' } });
    const session = await host.waitFor('session:issued');

    // Disconnect (client side), with the session context and the reason.
    host.socket.disconnect();
    await eventually(() => linesWith('socket disconnected').length === 1, 'disconnect line');
    expect(linesWith('socket disconnected')[0]).toMatchObject({
      reason: 'client namespace disconnect',
      roomId: session.roomId,
      playerId: session.playerId,
      role: 'player',
      ip: '127.0.0.1',
    });

    // Resume success on a new socket.
    const back = await h.connect();
    back.send('session:resume', { sessionToken: session.sessionToken });
    await back.waitFor('session:issued');
    await eventually(() => linesWith('session resumed').length === 1, 'resume line');
    expect(linesWith('session resumed')[0]).toMatchObject({ roomId: session.roomId, playerId: session.playerId });

    // Resume failure: an unknown (well-formed) token.
    const stranger = await h.connect();
    stranger.send('session:resume', { sessionToken: 'z'.repeat(43) });
    await stranger.waitFor('error');
    await eventually(() => linesWith('session resume failed').length === 1, 'resume failure line');
    expect(linesWith('session resume failed')[0]).toMatchObject({ code: 'INVALID_SESSION', playerId: null });

    // Errors sent to clients, with their codes: the incident's NOT_IN_ROOM (move on an unbound
    // socket), an invalid payload and an unknown event.
    stranger.send('game:move', { roomId: session.roomId, move: { type: 'take' }, expectedVersion: 0 });
    stranger.send('game:move', { nope: true });
    stranger.send('no:such:event', {});
    await eventually(() => linesWith('error sent to client').length >= 4, 'error lines');
    // Handlers are async, so these lines may come in a different order than the events were sent.
    const codes = linesWith('error sent to client').map((l) => [l.code, l.event ?? null]);
    expect(codes).toHaveLength(4);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['INVALID_SESSION', 'session:resume'],
        ['NOT_IN_ROOM', null],
        ['INVALID_PAYLOAD', 'game:move'],
        ['INVALID_PAYLOAD', 'unknown'],
      ]),
    );

    // Never a session token, in any line.
    expect(raw.join('')).not.toContain(session.sessionToken);
    expect(raw.join('')).not.toContain('z'.repeat(43));
  });

  it('logs a refused handshake (foreign Origin)', async () => {
    const h = await start();
    await expect(h.connect({ origin: 'https://evil.example' })).rejects.toBeTruthy();
    await eventually(() => linesWith('handshake refused: origin not allowed').length === 1, 'origin refusal');
    expect(linesWith('handshake refused: origin not allowed')[0]).toMatchObject({ origin: 'https://evil.example' });
  });
});
