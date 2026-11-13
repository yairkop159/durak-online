import { getLegalMovesForView } from '@durak/game-engine';
import { GAME_ERROR_CODES, type Card, type ClientMove } from '@durak/shared';
import { LayoutGroup, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnchorProvider, AnchorRegistry } from '../../anim/anchors';
import { FlightLayer } from '../../anim/FlightLayer';
import { planFlights, useBoardAnimation, type Flight } from '../../anim/useBoardAnimation';
import { awaitedPlayers } from '../../game/awaited';
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
import { sortHand } from '../../game/sortHand';
import { t } from '../../i18n';
import { useCountdown } from '../../net/clock';
import { useClient, useClientState } from '../../net/react';
import { GameOverOverlay } from './GameOverOverlay';
import { HandFan } from './HandFan';
import { ActionBar, Countdown, StatusBanner } from './parts';
import { MySeat, OpponentSeat, type TurnRing } from './Seat';
import { statusLine } from './status';
import { DeckPile, DiscardPile, TableArea } from './TableSurface';

const GAME_ERRORS: ReadonlySet<string> = new Set(GAME_ERROR_CODES);
const LAST_BOUT_PEEK_MS = 2500;

/** True for `ms` after `trigger` changes to a truthy key (false right away for a falsy one). */
function useFlash(key: number | null, ms: number): boolean {
  const [shownFor, setShownFor] = useState<number | null>(null);
  useEffect(() => {
    if (key === null) return;
    setShownFor(key);
    const timer = setTimeout(() => setShownFor((k) => (k === key ? null : k)), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && shownFor === key;
}

/** Becomes true `delayMs` after `key` changes (immediately when the delay is 0). */
function useDelayed(key: number, delayMs: number): boolean {
  const [readyFor, setReadyFor] = useState<number | null>(null);
  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setReadyFor(key), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);
  return delayMs <= 0 || readyFor === key;
}

export function TableScreen() {
  const client = useClient();
  const { game, room, gameOver, lastError } = useClientState();
  // Selection belongs to one game version: any new state (ours or anyone's move) clears it.
  const [picked, setPicked] = useState<{ version: number; selection: Selection }>({ version: -1, selection: NO_SELECTION });
  const remaining = useCountdown(game, client.now);
  const reduced = useReducedMotion() ?? false;
  const anim = useBoardAnimation(game, reduced);

  const [registry] = useState(() => new AnchorRegistry());
  const [flights, setFlights] = useState<{ version: number; list: readonly Flight[] }>({ version: -1, list: [] });
  const plannedFor = useRef(-1);

  const view = game?.view;
  const moves = useMemo(() => (view ? getLegalMovesForView(view) : []), [view]);
  const hand = useMemo(() => (view ? sortHand(view.hand, view.trumpSuit) : []), [view]);

  // After each commit: plan this version's flights from the *previous* positions, then remember the new ones.
  useLayoutEffect(() => {
    if (view && plannedFor.current !== anim.version) {
      plannedFor.current = anim.version;
      const list = planFlights(anim, view, registry);
      setFlights({ version: anim.version, list });
    }
    registry.snapshot();
  });

  // A move the server rejected: shake the hand.
  const [shakeHand, setShakeHand] = useState(false);
  useEffect(() => {
    if (lastError && GAME_ERRORS.has(lastError.code)) setShakeHand(true);
  }, [lastError]);

  const resolved = anim.events.some((e) => e.type === 'beaten' || e.type === 'taken');
  const peek = useFlash(resolved ? anim.version : null, LAST_BOUT_PEEK_MS);
  const overlayReady = useDelayed(anim.version, anim.timeline.totalMs);

  // Full turn length for the ring = what was left when this state arrived.
  const fullMs = game && game.turnDeadline !== null ? Math.max(1, game.turnDeadline - game.serverTime) : null;
  const fraction = remaining !== null && fullMs !== null ? remaining / fullMs : null;

  if (!game || !view) return null;

  const selection = picked.version === game.version ? picked.selection : NO_SELECTION;
  const members = room?.members;
  const nameOf = (id: string) => nicknameOf(id, members);
  const spectator = view.viewerId === null;
  const finished = view.phase.kind === 'finished' || room?.status === 'finished';
  const interactive = !spectator && !finished;
  const me = view.players.find((p) => p.id === view.viewerId);
  const awaited = awaitedPlayers(view, interactive ? moves : []);
  const ringOf = (id: string): TurnRing => ({
    progress: !finished && awaited.has(id) ? (fraction ?? 1) : null,
    urgent: remaining !== null && remaining <= 5000 && awaited.has(id),
  });
  const myTurn = interactive && moves.length > 0;

  const apply = ({ move, selection: next }: ClickResult) => {
    setPicked({ version: game.version, selection: next });
    if (move) client.sendMove(move);
  };
  const send = (move: ClientMove) => {
    setPicked({ version: game.version, selection: NO_SELECTION });
    client.sendMove(move);
  };

  return (
    <AnchorProvider registry={registry}>
      <LayoutGroup>
        <div className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 px-2 pt-2 sm:px-4 sm:pt-4">
          <ul className="flex flex-wrap justify-center gap-1.5 sm:gap-2.5" dir="ltr" aria-label="opponents">
            {opponentsInOrder(view).map((p) => (
              <OpponentSeat
                key={p.id}
                player={p}
                name={nameOf(p.id)}
                view={view}
                member={members?.find((m) => m.playerId === p.id)}
                ring={ringOf(p.id)}
              />
            ))}
          </ul>

          <section
            className="mx-auto flex w-full items-center gap-2 rounded-table bg-gradient-to-b from-surface-2 to-surface p-3 shadow-table ring-1 ring-line sm:gap-4 sm:p-4"
            dir="ltr"
          >
            <DeckPile view={view} />
            <TableArea
              table={view.table}
              anim={anim}
              moves={moves}
              selection={selection}
              interactive={interactive}
              transferMove={transferTarget(moves, selection)}
              onAttackClick={(index) => apply(clickAttackCard(index, moves, selection))}
              onTransferClick={() => apply(clickTransfer(moves, selection))}
            />
            <DiscardPile view={view} showLastBout={peek && view.table.length === 0} />
          </section>

          {!finished && (
            <StatusBanner
              text={spectator ? t.table.spectating : statusLine(view, moves, nameOf, t)}
              myTurn={myTurn}
              countdown={<Countdown ms={remaining} fraction={fraction} />}
            />
          )}

          <div className="mt-auto flex flex-col items-center">
            {!spectator && me && (
              <>
                <MySeat player={me} name={nameOf(me.id)} view={view} member={members?.find((m) => m.playerId === me.id)} ring={ringOf(me.id)} />
                <HandFan
                  hand={hand}
                  anim={anim}
                  moves={moves}
                  selection={selection}
                  interactive={interactive}
                  shakeHand={shakeHand}
                  onShakeHandEnd={() => setShakeHand(false)}
                  onCardClick={(card: Card) => interactive && apply(clickHandCard(card, moves, selection))}
                />
              </>
            )}
            {interactive && <ActionBar moves={moves} onMove={send} />}
          </div>

          <FlightLayer key={flights.version} flights={flights.list} />

          {finished && overlayReady && (
            <GameOverOverlay view={view} gameOver={gameOver} nameOf={nameOf} canRematch={!spectator} reduced={reduced} />
          )}
        </div>
      </LayoutGroup>
    </AnchorProvider>
  );
}
