import { getLegalMovesForView } from '@durak/game-engine';
import type { Card, ClientMove } from '@durak/shared';
import { useMemo, useState } from 'react';
import { sortHand } from '../../game/sortHand';
import { nicknameOf, opponentsInOrder } from '../../game/seats';
import {
  NO_SELECTION,
  clickAttackCard,
  clickHandCard,
  clickTransfer,
  transferTarget,
  type ClickResult,
  type Selection,
} from '../../game/selection';
import { t } from '../../i18n';
import { useCountdown } from '../../net/clock';
import { useClient, useClientState } from '../../net/react';
import { GameOverOverlay } from './GameOverOverlay';
import { ActionBar, Countdown, DeckArea, MyHand, OpponentSeat, PlayerBadges, TableArea } from './parts';
import { statusLine } from './status';

export function TableScreen() {
  const client = useClient();
  const { game, room, gameOver } = useClientState();
  // Selection belongs to one game version: any new state (ours or anyone's move) clears it.
  const [picked, setPicked] = useState<{ version: number; selection: Selection }>({ version: -1, selection: NO_SELECTION });
  const remaining = useCountdown(game, client.now);

  const view = game?.view;
  const moves = useMemo(() => (view ? getLegalMovesForView(view) : []), [view]);
  const hand = useMemo(() => (view ? sortHand(view.hand, view.trumpSuit) : []), [view]);
  if (!game || !view) return null;

  const selection = picked.version === game.version ? picked.selection : NO_SELECTION;
  const members = room?.members;
  const nameOf = (id: string) => nicknameOf(id, members);
  const spectator = view.viewerId === null;
  const finished = view.phase.kind === 'finished' || room?.status === 'finished';
  const interactive = !spectator && !finished;
  const me = view.players.find((p) => p.id === view.viewerId);

  const apply = ({ move, selection: next }: ClickResult) => {
    setPicked({ version: game.version, selection: next });
    if (move) client.sendMove(move);
  };
  const send = (move: ClientMove) => {
    setPicked({ version: game.version, selection: NO_SELECTION });
    client.sendMove(move);
  };

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-2 p-2 sm:p-4">
      <ul className="flex flex-wrap justify-center gap-2" dir="ltr" aria-label="opponents">
        {opponentsInOrder(view).map((p) => (
          <OpponentSeat
            key={p.id}
            player={p}
            name={nameOf(p.id)}
            view={view}
            member={members?.find((m) => m.playerId === p.id)}
          />
        ))}
      </ul>

      <div className="flex flex-1 items-center gap-2 rounded-3xl bg-emerald-800/70 p-3 ring-1 ring-black/20 sm:gap-4">
        <DeckArea view={view} />
        <TableArea
          table={view.table}
          moves={moves}
          selection={selection}
          interactive={interactive}
          transferMove={transferTarget(moves, selection)}
          onAttackClick={(index) => apply(clickAttackCard(index, moves, selection))}
          onTransferClick={() => apply(clickTransfer(moves, selection))}
        />
      </div>

      {!finished && (
        <div className="flex items-center justify-center gap-3 text-sm" aria-live="polite">
          <span data-testid="status">{spectator ? t.table.spectating : statusLine(view, moves, nameOf, t)}</span>
          <Countdown ms={remaining} />
        </div>
      )}

      {interactive && <ActionBar moves={moves} onMove={send} />}

      {!spectator && me && (
        <div className="flex flex-col items-center">
          <PlayerBadges player={me} view={view} member={members?.find((m) => m.playerId === me.id)} />
          <MyHand
            hand={hand}
            moves={moves}
            selection={selection}
            interactive={interactive}
            onCardClick={(card: Card) => interactive && apply(clickHandCard(card, moves, selection))}
          />
        </div>
      )}

      {finished && <GameOverOverlay view={view} gameOver={gameOver} nameOf={nameOf} canRematch={!spectator} />}
    </div>
  );
}
