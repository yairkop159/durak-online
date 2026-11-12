import { randomBytes } from 'node:crypto';
import { createGame } from '@durak/game-engine';
import type { Room, Session, StoredGame } from '../../src/domain/types.js';

export const uid = () => randomBytes(5).toString('hex');

export function makeRoom(id = uid(), status: Room['status'] = 'lobby'): Room {
  return {
    id,
    hostId: 'p_host',
    maxPlayers: 4,
    config: { mode: 'perevodnoy' },
    members: [
      { playerId: 'p_host', nickname: 'Host', connected: true, isBot: false },
      { playerId: 'p_guest', nickname: 'Guest', connected: true, isBot: false },
    ],
    spectators: [{ spectatorId: 's_1', nickname: 'Watcher' }],
    status,
    createdAt: 1_700_000_000_000,
  };
}

export function makeGame(roomId: string, finished = false): StoredGame {
  const created = createGame({ playerIds: ['p_host', 'p_guest'], seed: 99, config: { mode: 'perevodnoy' } });
  if (!created.ok) throw new Error(created.error.message);
  const state = finished ? { ...created.value, phase: { kind: 'finished' as const, durak: 'p_guest' } } : created.value;
  return { roomId, seed: 99, version: 7, state, startedAt: 1_700_000_000_500 };
}

export function makeSession(roomId = uid()): Session {
  return { token: randomBytes(32).toString('base64url'), roomId, role: 'player', id: 'p_host' };
}
