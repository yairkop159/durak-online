import { randomBytes } from 'node:crypto';
import { createGame, initKnowledge, sanitizeStateForPlayer } from '@durak/game-engine';
import type { Room, Session, StoredGame } from '../../src/domain/types.js';

export const uid = () => randomBytes(5).toString('hex');

export function makeRoom(id = uid(), status: Room['status'] = 'lobby'): Room {
  return {
    id,
    hostId: 'p_host',
    maxPlayers: 4,
    config: { mode: 'perevodnoy' },
    members: [
      { playerId: 'p_host', nickname: 'Host', connected: true, isBot: false, botDifficulty: null, afk: false, consecutiveTimeouts: 0, graceDeadline: null, leftGame: false, profileId: null },
      { playerId: 'p_guest', nickname: 'Guest', connected: true, isBot: false, botDifficulty: null, afk: false, consecutiveTimeouts: 0, graceDeadline: null, leftGame: false, profileId: null },
      { playerId: 'p_bot', nickname: 'Bot 1', connected: true, isBot: true, botDifficulty: 'hard', afk: false, consecutiveTimeouts: 0, graceDeadline: null, leftGame: false, profileId: null },
    ],
    spectators: [{ spectatorId: 's_1', nickname: 'Watcher' }],
    status,
    createdAt: 1_700_000_000_000,
    restartVote: null,
    restartCooldowns: {},
  };
}

export function makeGame(roomId: string, finished = false): StoredGame {
  const created = createGame({ playerIds: ['p_host', 'p_guest'], seed: 99, config: { mode: 'perevodnoy' } });
  if (!created.ok) throw new Error(created.error.message);
  const state = finished ? { ...created.value, phase: { kind: 'finished' as const, durak: 'p_guest' } } : created.value;
  return {
    roomId,
    gameId: 'g_fixture',
    seed: 99,
    version: 7,
    state,
    startedAt: 1_700_000_000_500,
    turnDeadline: finished ? null : 1_700_000_030_500,
    timeoutStreak: 1,
    endReason: finished ? 'normal' : null,
    knowledge: {
      p_host: { viewerId: 'p_host', discard: ['6S'], knownHands: { p_guest: ['AH'] } },
      p_guest: initKnowledge(sanitizeStateForPlayer(state, 'p_guest')),
    },
    botAssisted: ['p_guest'],
    forfeits: [],
    stats: {
      p_host: { boutsAttacked: 2, boutsDefended: 1, defenses: 1, takes: 0, cardsTaken: 0, throwIns: 1, transfers: 0, cardsPlayed: 5 },
    },
    profiles: { p_host: 'profHostAAAAAAAAAAAAAA' },
    ratings: finished ? [{ playerId: 'p_host', before: 1000, after: 1016, delta: 16 }, { playerId: 'p_guest', before: 1000, after: 984, delta: -16 }] : null,
  };
}

export function makeSession(roomId = uid()): Session {
  return { token: randomBytes(32).toString('base64url'), roomId, role: 'player', id: 'p_host' };
}
