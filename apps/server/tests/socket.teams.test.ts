import { afterEach, describe, expect, it } from 'vitest';
import { setupRoom, startGame, startTestServer, type TestHarness } from './helpers/testServer.js';

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('team mode over sockets', () => {
  it('room:state carries the config; room:setTeams and room:swapSeats update it for everyone', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [guest], 4, { mode: 'perevodnoy' });
    expect(host.last('room:state')!.config).toEqual({ mode: 'perevodnoy', teams: false });

    let since = guest.mark();
    host.send('room:setTeams', { roomId, teams: true });
    await guest.waitFor('room:state', (s) => s.config.teams, since);

    host.send('room:addBot', { roomId, difficulty: 'easy' });
    host.send('room:addBot', { roomId, difficulty: 'easy' });
    const full = await guest.waitFor('room:state', (s) => s.members.length === 4);
    const ids = full.members.map((m) => m.playerId);

    since = guest.mark();
    host.send('room:swapSeats', { roomId, a: sessions[1]!.playerId, b: ids[2]! });
    const swapped = await guest.waitFor('room:state', (s) => s.members[2]?.playerId === sessions[1]!.playerId, since);
    expect(swapped.members.map((m) => m.playerId)).toEqual([ids[0], ids[2], ids[1], ids[3]]);

    await startGame(host, [host, guest], roomId);
    const view = guest.last('game:state')!.view;
    expect(view.config.teams).toBe(true);
    expect(view.players.map((p) => p.id)).toEqual([ids[0], ids[2], ids[1], ids[3]]);
  });

  it('bad payloads and wrong rooms are refused with an error event', async () => {
    harness = await startTestServer();
    const host = await harness.connect();
    const guest = await harness.connect();
    const { roomId, sessions } = await setupRoom(host, [guest], 3);

    let since = host.mark();
    host.send('room:swapSeats', { roomId, a: sessions[0]!.playerId, b: sessions[0]!.playerId });
    expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');

    since = host.mark();
    host.send('room:setTeams', { roomId, teams: true });
    expect((await host.waitFor('error', () => true, since)).code).toBe('TEAMS_NEED_FOUR');

    since = guest.mark();
    guest.send('room:swapSeats', { roomId, a: sessions[0]!.playerId, b: sessions[1]!.playerId });
    expect((await guest.waitFor('error', () => true, since)).code).toBe('NOT_HOST');

    since = host.mark();
    host.send('room:create', { nickname: 'x', maxPlayers: 5, config: { teams: true } });
    // This connection already holds a session, so it is re-issued, but the payload itself is invalid first.
    expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');
  });
});
