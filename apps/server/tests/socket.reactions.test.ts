import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | undefined;
let raw: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  raw = [];
});

async function threeInRoom() {
  harness = await startTestServer({ logger: { level: 'info', stream: { write: (line: string) => void raw.push(line) } } });
  const host = await harness.connect();
  host.send('room:create', { nickname: 'Host', maxPlayers: 2 });
  const { roomId, playerId: hostId } = await host.waitFor('session:issued');
  const guest = await harness.connect();
  guest.send('room:join', { roomId, nickname: 'Guest' });
  await guest.waitFor('session:issued');
  const watcher = await harness.connect();
  watcher.send('room:join', { roomId, nickname: 'Watcher' });
  await watcher.waitFor('session:issued');
  return { host, guest, watcher, roomId, hostId };
}

describe('room:react over sockets', () => {
  it('a seated player’s reaction reaches everyone in the room, spectators included', async () => {
    const { host, guest, watcher, roomId, hostId } = await threeInRoom();
    host.send('room:react', { roomId, reactionId: 'fire' });
    const expected = { roomId, playerId: hostId, reactionId: 'fire' };
    for (const c of [host, guest, watcher]) expect(await c.waitFor('room:reaction')).toEqual(expected);
  });

  it('spectators get NOT_IN_ROOM; unknown ids and free text get INVALID_PAYLOAD; payloads are never logged', async () => {
    const { host, watcher, roomId } = await threeInRoom();
    let since = watcher.mark();
    watcher.send('room:react', { roomId, reactionId: 'clap' });
    expect((await watcher.waitFor('error', () => true, since)).code).toBe('NOT_IN_ROOM');
    since = host.mark();
    host.send('room:react', { roomId, reactionId: 'secret-free-text' });
    expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');
    since = host.mark();
    host.send('room:react', { roomId, reactionId: 'clap', text: 'secret-extra' });
    expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');
    expect(host.all('room:reaction')).toEqual([]);
    expect(raw.join('')).not.toContain('secret-');
  });

  it('over the per-player limit, reactions are dropped silently (no error, no broadcast)', async () => {
    const { host, guest, roomId } = await threeInRoom();
    for (let i = 0; i < 5; i++) host.send('room:react', { roomId, reactionId: 'laugh' });
    guest.send('room:react', { roomId, reactionId: 'ohNo' });
    await host.waitFor('room:reaction', (r) => r.reactionId === 'ohNo');
    expect(host.all('room:reaction').filter((r) => r.reactionId === 'laugh')).toHaveLength(3);
    expect(host.all('error')).toEqual([]);
  });
});
