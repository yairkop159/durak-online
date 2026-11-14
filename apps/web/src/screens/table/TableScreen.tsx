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
import { isReconnecting } from '../../net/store';
import { GameOverOverlay } from './GameOverOverlay';
import { HandFan } from './HandFan';
import { ActionBar, Countdown, StatusBanner } from './parts';
import { MySeat, OpponentSeat, type SeatEffectProp, type TurnRing } from './Seat';
import { statusLine } from './status';
import { RestartButton, RestartVotePanel, canProposeRestart } from './RestartVote';
import { TopBar } from './TopBar';
import { useGameSounds } from '../../audio/useGameSounds';
import { SettingsButton } from '../../components/SettingsDialog';
import { HelpButton } from '../rules/HelpButton';
import { TipBanner } from '../../tips/TipBanner';
import { tipFor, tipLearnedBy } from '../../tips/tips';
import { useSettingsStore } from '../../settings/react';
import { useSettings } from '../../settings/react';
import { ANIMATION_SPEED_FACTOR } from '../../settings/settings';
import { DeckPile, DiscardPile, TableArea } from './TableSurface';
import { useLayoutMode } from '../../layout/layoutMode';
import { useWakeLock } from '../../phone/wakeLock';
import { useReactions } from '../../reactions/useReactions';
import { ReactionAnnouncer } from '../../reactions/ReactionBubble';
import { ReactionButton } from '../../reactions/ReactionPicker';
import { seatEffects } from '../../anim/moments';
import { planReveal } from '../../anim/reveal';
import { gameOverCue } from '../../audio/soundPlan';
import { DurakReveal } from '../../moments/DurakReveal';
import { MomentBanner } from '../../moments/MomentBanner';
import { useMomentQueue } from '../../moments/useMomentQueue';

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
  const state = useClientState();
  const { game, room, gameOver, lastError } = state;
  // Disconnected or re-binding the seat: moves would be dropped, so don't offer any.
  const reconnecting = isReconnecting(state);
  // Selection belongs to one game version: any new state (ours or anyone's move) clears it.
  const [picked, setPicked] = useState<{ version: number; selection: Selection }>({ version: -1, selection: NO_SELECTION });
  const remaining = useCountdown(game, client.now);
  const reduced = useReducedMotion() ?? false;
  const mode = useLayoutMode();
  const short = mode === 'short';
  const settings = useSettings();
  const settingsStore = useSettingsStore();
  const speed = ANIMATION_SPEED_FACTOR[settings.animationSpeed];
  const anim = useBoardAnimation(game, reduced, speed);

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

  const viewerId = view?.viewerId ?? null;
  const gameFinished = view?.phase.kind === 'finished';

  // The durak reveal runs only for a game we watched finish (not after a reload into a finished game).
  const sawRunning = useRef<string | null>(null);
  useEffect(() => {
    if (game && !gameFinished) sawRunning.current = game.gameId;
  }, [game, gameFinished]);
  const revealPlan = useMemo(
    () =>
      game && view && gameFinished && gameOver && sawRunning.current === game.gameId
        ? planReveal(gameOver, view, { reduced, speed })
        : null,
    // Planned once per finished game (a later re-render must not restart it).
    [game?.gameId, gameFinished, gameOver, reduced],
  );
  const [revealDoneFor, setRevealDoneFor] = useState<string | null>(null);

  // The screen stays on while the game runs (released when it ends, re-taken after the page was hidden).
  useWakeLock(!!view && !gameFinished && room?.status === 'playing');

  const soundTurn = !!view && viewerId !== null && !gameFinished && !reconnecting && moves.length > 0;
  useGameSounds({ anim, myTurn: soundTurn, remaining, gameOver, viewerId, stingerByReveal: revealPlan !== null });
  const reactions = useReactions();
  const moment = useMomentQueue(anim, { speed, enabled: !!view && !gameFinished && !reconnecting });

  if (!game || !view) return null;

  const selection = picked.version === game.version ? picked.selection : NO_SELECTION;
  const members = room?.members;
  const nameOf = (id: string) => nicknameOf(id, members);
  const spectator = view.viewerId === null;
  const finished = view.phase.kind === 'finished' || room?.status === 'finished';
  const interactive = !spectator && !finished && !reconnecting;
  const me = view.players.find((p) => p.id === view.viewerId);
  const myMember = me ? members?.find((m) => m.playerId === me.id) : undefined;
  // Seated players who still hold their seat (not spectators, not a seat a bot took over).
  const canReact = reactions.enabled && !!myMember && !myMember.leftGame && !myMember.isBot;
  const awaited = awaitedPlayers(view, interactive ? moves : []);
  const ringOf = (id: string): TurnRing => ({
    progress: !finished && awaited.has(id) ? (fraction ?? 1) : null,
    urgent: remaining !== null && remaining <= 5000 && awaited.has(id),
  });
  const myTurn = interactive && moves.length > 0;
  const effects = moment ? seatEffects(moment.moment) : null;
  const effectOf = (id: string): SeatEffectProp => (moment && effects?.has(id) ? { kind: effects.get(id)!, id: moment.id } : null);
  const revealing = finished && overlayReady && revealPlan !== null && revealDoneFor !== game.gameId;

  // First-game tips: shown for the current situation until dismissed or acted on once.
  // A short landscape screen has no room for them (they show in portrait and on bigger screens).
  const tip = settings.showTips && interactive && !short ? tipFor(view, moves, settings.tipsSeen) : null;
  const sendMove = (move: ClientMove) => {
    if (tip && tipLearnedBy(tip, move)) settingsStore.markTipSeen(tip);
    client.sendMove(move);
  };
  const apply = ({ move, selection: next }: ClickResult) => {
    setPicked({ version: game.version, selection: next });
    if (move) sendMove(move);
  };
  const send = (move: ClientMove) => {
    setPicked({ version: game.version, selection: NO_SELECTION });
    sendMove(move);
  };

  const opponents = (
    <ul
      className={`flex shrink-0 justify-center ${short ? 'min-w-0 flex-nowrap gap-1' : 'flex-wrap gap-1.5 sm:gap-2.5'} ${mode === 'phone' ? 'gap-1' : ''}`}
      dir="ltr"
      aria-label="opponents"
    >
      {opponentsInOrder(view).map((p) => (
        <OpponentSeat
          key={p.id}
          player={p}
          name={nameOf(p.id)}
          view={view}
          member={members?.find((m) => m.playerId === p.id)}
          ring={ringOf(p.id)}
          reaction={reactions.byPlayer.get(p.id) ?? null}
          effect={effectOf(p.id)}
          reduced={reduced}
          variant={short ? 'inline' : mode === 'phone' ? 'compact' : 'regular'}
        />
      ))}
    </ul>
  );
  const tableArea = (
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
  );
  const status = (
    <StatusBanner
      text={spectator ? t.table.spectating : statusLine(view, moves, nameOf, t)}
      myTurn={myTurn}
      countdown={<Countdown ms={remaining} fraction={fraction} />}
      compact={short}
    />
  );
  const mySeat = me && (
    <MySeat
      player={me}
      name={nameOf(me.id)}
      view={view}
      member={myMember}
      ring={ringOf(me.id)}
      reaction={reactions.byPlayer.get(me.id) ?? null}
      effect={effectOf(me.id)}
      reduced={reduced}
      extra={canReact && <ReactionButton disabled={reconnecting} />}
    />
  );
  const handFan = (
    <HandFan
      hand={hand}
      anim={anim}
      moves={moves}
      selection={selection}
      interactive={interactive}
      shakeHand={shakeHand}
      onShakeHandEnd={() => setShakeHand(false)}
      onCardClick={(card: Card) => interactive && apply(clickHandCard(card, moves, selection))}
      short={short}
    />
  );

  return (
    <AnchorProvider registry={registry}>
      <LayoutGroup>
        {/* Exactly one screen tall (App sets h-dvh): the table takes what the other rows leave. */}
        <div
          className={`relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-2 pt-2 sm:px-4 ${
            short ? 'max-w-none gap-1.5 pt-1.5 sm:pt-1.5' : 'gap-2 sm:gap-3 sm:pt-3 [@media(max-height:820px)]:gap-2'
          }`}
          data-layout={mode}
        >
          <TopBar
            view={view}
            members={members}
            extra={
              <>
                {canProposeRestart(view, room) && <RestartButton disabled={!!room?.restartVote || reconnecting} />}
                <HelpButton />
                <SettingsButton />
              </>
            }
          />
          <RestartVotePanel viewerId={view.viewerId} />
          {opponents}

          <section
            className={`mx-auto flex min-h-0 w-full flex-1 gap-2 rounded-table bg-gradient-to-b from-surface-2 to-surface p-2 shadow-table ring-1 ring-line sm:gap-4 sm:p-4 ${
              mode === 'phone' ? 'flex-col' : 'items-center'
            } ${short ? 'sm:gap-2 sm:p-2' : ''}`}
            dir="ltr"
          >
            {mode === 'phone' ? (
              // Phones: the stock and the discard pile become one small strip, the table gets the full width.
              <div className="flex shrink-0 items-center justify-between px-1" data-testid="piles">
                <DeckPile view={view} small />
                <DiscardPile view={view} showLastBout={peek && view.table.length === 0} small />
              </div>
            ) : (
              <DeckPile view={view} small={short} />
            )}
            {tableArea}
            {mode !== 'phone' && <DiscardPile view={view} showLastBout={peek && view.table.length === 0} small={short} />}
          </section>

          {!finished && !short && status}

          <div
            className={`flex shrink-0 pb-[env(safe-area-inset-bottom)] transition duration-500 ${
              short ? 'flex-row-reverse items-end gap-2' : 'flex-col items-center gap-1.5 sm:gap-2'
            } ${revealing ? 'translate-y-24 opacity-0' : ''}`}
          >
            {tip && <TipBanner tip={tip} onDismiss={() => settingsStore.markTipSeen(tip)} />}
            {short ? (
              // Short landscape: the hand takes the width; my seat, the status and Take/Pass stand beside it.
              <>
                <div className="flex w-72 shrink-0 flex-col items-stretch gap-1 pb-1" data-testid="side-panel">
                  {!finished && status}
                  {!spectator && me && (
                    <div className="flex items-center justify-between gap-1.5">
                      {mySeat}
                      {interactive && <ActionBar moves={moves} onMove={send} compact />}
                    </div>
                  )}
                </div>
                {!spectator && me && <div className="min-w-0 flex-1">{handFan}</div>}
              </>
            ) : (
              !spectator &&
              me && (
                <>
                  {/* My seat and Take / Pass share the row ABOVE the hand: the buttons can never cover (or steal clicks from) a card. */}
                  <div className="flex w-full max-w-xl items-center justify-between gap-2 px-1">
                    {mySeat}
                    {interactive && <ActionBar moves={moves} onMove={send} />}
                  </div>
                  {handFan}
                </>
              )
            )}
          </div>

          <FlightLayer key={flights.version} flights={flights.list} />
          <ReactionAnnouncer latest={reactions.latest} nameOf={nameOf} />
          <MomentBanner active={moment} viewerId={viewerId} nameOf={nameOf} reduced={reduced} />

          {revealing && revealPlan && (
            <DurakReveal
              plan={revealPlan}
              viewerId={viewerId}
              nameOf={nameOf}
              stinger={gameOver ? gameOverCue(gameOver, viewerId) : null}
              onDone={() => setRevealDoneFor(game.gameId)}
            />
          )}

          {finished && overlayReady && !revealing && gameOver?.endReason !== 'restarted' && (
            <GameOverOverlay
              view={view}
              gameOver={gameOver}
              nameOf={nameOf}
              canRematch={!spectator}
              reduced={reduced}
              reactions={reactions}
              canReact={canReact}
            />
          )}
        </div>
      </LayoutGroup>
    </AnchorProvider>
  );
}
