/**
 * Phone returning from the background: the web client opens a NEW socket and resumes on it, while
 * the OLD (zombie) socket may only time out on the server 20-45 s later. When that old socket's
 * `disconnect` finally fires, the player must stay connected: no grace timer, no room:state
 * change, the turn timer untouched.
 *
 * Why it holds (registerHandlers.ts `disconnect` -> RoomService.markDisconnected): inside the room
 * lock, `isStillOffline` asks whether any socket is still in the player's channel; the new socket
 * joined it on resume, so markDisconnected returns before touching the room.
 *
 * Coincidence-proof: the test awaits the exact markDisconnected call the old socket triggered and
 * checks what isStillOffline answered, uses a reaction broadcast as an ordering barrier for
 * "no room:state", and the control half shows the same path DOES start a grace once the last
 * socket goes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/domain/types.js';
import { setupRoom, startGame, startTestServer, type TestHarness, type TestClient } from './helpers/testServer.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

/** Records every markDisconnected call: its promise and what isStillOffline answered. */
function watchMarkDisconnected(h: TestHarness) {
  const calls: { session: Session; done: Promise<void>; stillOffline: boolean[] }[] = [];
  const rooms = h.server.rooms;
  const original = rooms.markDisconnected.bind(rooms);
  vi.spyOn(rooms, 'markDisconnected').mockImplementation((session, isStillOffline) => {
    const stillOffline: boolean[] = [];
    const done = original(session, async () => {
      const answer = await isStillOffline();
      stillOffline.push(answer);
      return answer;
    });
    calls.push({ session, done, stillOffline });
    return done;
  });
  return calls;
}

async function waitForCalls(calls: unknown[], n: number): Promise<void> {
  for (let i = 0; i < 200 && calls.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  expect(calls.length).toBe(n);
}

/** Everything the server sent `host` before this returns has arrived (a room broadcast as a barrier). */
async function barrier(host: TestClient, roomId: string): Promise<void> {
  const since = host.mark();
  host.send('room:react', { roomId, reactionId: 'laugh' });
  await host.waitFor('room:reaction', () => true, since);
}

describe('a stale socket disconnecting after the player resumed on a new one', () => {
  it('leaves the player connected: no grace, no room:state, the turn timer untouched', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const oldSocket = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [oldSocket]);
    await startGame(host, [host, oldSocket], roomId);
    const guest = sessions[1]!;
    const calls = watchMarkDisconnected(harness);

    // The phone comes back: a new socket resumes the same session (the old one is still open).
    const newSocket = await harness.connect();
    newSocket.send('session:resume', { sessionToken: guest.sessionToken });
    await newSocket.waitFor('session:issued');
    await newSocket.waitFor('game:state');
    await barrier(host, roomId);

    const roomBefore = await harness.server.repos.rooms.get(roomId);
    const gameBefore = await harness.server.repos.games.get(roomId);
    const timersBefore = [...harness.time.pending];
    const since = host.mark();

    // Much later the zombie socket finally drops on the server.
    oldSocket.socket.disconnect();
    await waitForCalls(calls, 1);
    expect(calls[0]!.session.id).toBe(guest.playerId);
    await calls[0]!.done;
    // The handler really ran its check, and the new socket made it answer "still online".
    expect(calls[0]!.stillOffline).toEqual([false]);

    await barrier(host, roomId);
    expect(host.received.slice(since).filter((r) => r.event === 'room:state')).toEqual([]);
    const roomAfter = await harness.server.repos.rooms.get(roomId);
    expect(roomAfter).toEqual(roomBefore);
    const member = roomAfter!.members.find((m) => m.playerId === guest.playerId)!;
    expect(member.connected).toBe(true);
    expect(member.graceDeadline).toBeNull();
    expect(harness.time.pending).toEqual(timersBefore); // no grace timer armed, turn timer unchanged
    const gameAfter = await harness.server.repos.games.get(roomId);
    expect(gameAfter?.version).toBe(gameBefore?.version);
    expect(gameAfter?.turnDeadline).toBe(gameBefore?.turnDeadline);

    // The new socket still plays: a move from it is accepted.
    const state = newSocket.all('game:state').at(-1)!;
    if (state.view.attackerId === guest.playerId) {
      const before = newSocket.mark();
      newSocket.send('game:move', { roomId, expectedVersion: state.version, move: { type: 'attack', card: state.view.hand[0]! } });
      await newSocket.waitFor('game:state', (s) => s.version === state.version + 1, before);
    }

    // Control: when the LAST socket goes, the same path marks the player offline and starts a grace.
    const sinceLast = host.mark();
    newSocket.socket.disconnect();
    await waitForCalls(calls, 2);
    await calls[1]!.done;
    expect(calls[1]!.stillOffline).toEqual([true]);
    const offline = await host.waitFor('room:state', (r) => r.members.some((m) => m.playerId === guest.playerId && !m.connected), sinceLast);
    expect(offline.status).toBe('playing');
    const graced = (await harness.server.repos.rooms.get(roomId))!.members.find((m) => m.playerId === guest.playerId)!;
    expect(graced.graceDeadline).not.toBeNull();
    expect(harness.time.pending.some((t) => t.at === graced.graceDeadline)).toBe(true);
  });
});
