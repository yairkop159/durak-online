import type { ErrorPayload, GameStatePayload } from '@durak/shared';
import type { TestClient } from './testServer.js';
import { chooseMove } from './viewStrategy.js';

/**
 * Makes `client` answer every new game:state with a move chosen from its own view,
 * echoing the received version as expectedVersion. Returns the errors it receives.
 */
export function autoPlay(client: TestClient, roomId: string): { errors: ErrorPayload[] } {
  const errors: ErrorPayload[] = [];
  let lastActed = -1;
  const act = (payload: GameStatePayload) => {
    if (payload.version <= lastActed) return;
    const move = chooseMove(payload.view);
    if (!move) return;
    lastActed = payload.version;
    client.send('game:move', { roomId, move, expectedVersion: payload.version });
  };
  client.socket.on('game:state', act);
  client.socket.on('error', (e) => errors.push(e));
  const latest = client.last('game:state');
  if (latest) act(latest);
  return { errors };
}
