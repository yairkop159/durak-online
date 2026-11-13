import { afterEach, describe, expect, it } from 'vitest';
import { InProcessRunner } from '../src/bot/InProcessRunner.js';
import { autoPlay } from './helpers/autoPlay.js';
import { startTestServer, type TestClient, type TestHarness } from './helpers/testServer.js';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function harness(): Promise<TestHarness> {
  const h = await startTestServer();
  harnesses.push(h);
  return h;
}

async function hostWithBot(h: TestHarness, difficulty = 'medium'): Promise<{ host: TestClient; roomId: string }> {
  const host = await h.connect();
  host.send('room:create', { nickname: 'human', maxPlayers: 2 });
  const { roomId } = await host.waitFor('session:issued');
  host.send('room:addBot', { roomId, difficulty });
  await host.waitFor('room:state', (r) => r.members.length === 2);
  return { host, roomId };
}

describe('bots over sockets', () => {
  it('room:addBot seats a bot with a public difficulty; room:removeBot removes it', async () => {
    const h = await harness();
    const { host, roomId } = await hostWithBot(h, 'hard');
    const room = host.last('room:state')!;
    const bot = room.members.find((m) => m.isBot)!;
    expect(bot).toMatchObject({ isBot: true, botDifficulty: 'hard', connected: true, afk: false, nickname: 'Bot 1' });

    host.send('room:removeBot', { roomId, playerId: bot.playerId });
    await host.waitFor('room:state', (r) => r.members.length === 1);
  });

  it('bot events are schema-validated and permission-checked', async () => {
    const h = await harness();
    const { host, roomId } = await hostWithBot(h);
    let since = host.mark();
    host.send('room:addBot', { roomId, difficulty: 'godlike' });
    expect((await host.waitFor('error', () => true, since)).code).toBe('INVALID_PAYLOAD');
    since = host.mark();
    host.send('room:addBot', { roomId, difficulty: 'easy' });
    expect((await host.waitFor('error', () => true, since)).code).toBe('ROOM_FULL');
    since = host.mark();
    host.send('room:removeBot', { roomId, playerId: host.last('session:issued')!.playerId });
    expect((await host.waitFor('error', () => true, since)).code).toBe('NOT_A_BOT');

    const stranger = await h.connect();
    stranger.send('room:addBot', { roomId, difficulty: 'easy' });
    expect((await stranger.waitFor('error')).code).toBe('NOT_IN_ROOM');
  });

  it('a 2-player human-vs-bot game over sockets plays to game:over', async () => {
    const h = await harness();
    const { host, roomId } = await hostWithBot(h);
    host.send('game:start', { roomId });
    await host.waitFor('game:state', (s) => s.version === 0);
    const { errors } = autoPlay(host, roomId);

    for (let i = 0; i < 2000 && !host.last('game:over'); i++) {
      await h.time.advanceBy(2_000);
      await new Promise((r) => setTimeout(r, 1)); // let the socket round-trip of the human's reply land
    }
    const over = host.last('game:over');
    expect(over).toBeDefined();
    expect(over!.endReason).toBe('normal');
    expect(over!.botAssisted).toEqual([]);
    expect(errors.filter((e) => e.code !== 'STALE_STATE')).toEqual([]);

    // Versions arrive in order with no gaps (a STALE_STATE resync may repeat the current one).
    const versions = host.all('game:state').map((s) => s.version);
    for (let i = 1; i < versions.length; i++) expect(versions[i]! - versions[i - 1]!).toBeOneOf([0, 1]);
    const stale = errors.filter((e) => e.code === 'STALE_STATE').length;
    expect(versions.length - new Set(versions).size).toBeLessThanOrEqual(stale);
    expect(h.server.bots.events.some((e) => e.kind === 'applied')).toBe(true);

    // Every job the bot received was serialized from the bot seat's own view.
    const runner = h.server.botRunner as InProcessRunner;
    const botId = host.last('room:state')!.members.find((m) => m.isBot)!.playerId;
    for (const json of runner.serializedJobs) {
      const job = JSON.parse(json) as { view: { viewerId: string } };
      expect(job.view.viewerId).toBe(botId);
    }
  });
});
