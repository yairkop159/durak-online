import { useMemo } from 'react';
import { leaveOutcome } from '../game/departure';
import { useClient, useClientState } from '../net/react';
import { isReconnecting } from '../net/store';
import { useReactions } from '../reactions/useReactions';
import { navigate } from '../routing';
import type { TableSource } from './table/source';
import { TableScreen } from './table/TableScreen';

/** The table of a real room: the socket client is the game source. */
export function OnlineTable() {
  const client = useClient();
  const state = useClientState();
  const reactions = useReactions();
  const { game, room, gameOver, ratings, lastError } = state;
  const reconnecting = isReconnecting(state);
  const members = room?.members;
  const outcome = game ? leaveOutcome(game.view, members) : 'none';

  const source = useMemo<TableSource>(
    () => ({
      game,
      members,
      room,
      gameOver,
      ratings,
      lastError,
      reconnecting,
      now: client.now,
      sendMove: (move) => client.sendMove(move),
      leave: {
        outcome,
        run: () => {
          client.leaveRoom();
          navigate('/');
        },
      },
      online: { reactions, rematch: () => client.rematch() },
    }),
    [client, game, members, room, gameOver, ratings, lastError, reconnecting, outcome, reactions],
  );
  return <TableScreen source={source} />;
}
