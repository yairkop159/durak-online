import { getLegalMovesForView } from '@durak/game-engine';
import { GAME_ERROR_CODES, type Card, type ClientMove } from '@durak/shared';
import { LayoutGroup, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  isPlayable,
  transferTarget,
  type ClickResult,
  type Selection,
} from '../../game/selection';
import { sortHand } from '../../game/sortHand';
import { t } from '../../i18n';
import { useCountdown } from '../../net/clock';
import { GameOverOverlay } from './GameOverOverlay';
import { HandFan } from './HandFan';
import { ActionBar, Countdown, StatusBanner } from './parts';
import { MySeat, OpponentSeat, type SeatEffectProp, type TurnRing } from './Seat';
import { statusLine } from './status';
import { RestartButton, RestartVotePanel, canProposeRestart } from './RestartVote';
import { LeaveButton, TopBar } from './TopBar';
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
import type { ReactionsInView } from '../../reactions/useReactions';
import type { TableSource } from './source';
import { ReactionAnnouncer } from '../../reactions/ReactionBubble';
import { ReactionButton } from '../../reactions/ReactionPicker';
import { seatEffects } from '../../anim/moments';
import { planReveal } from '../../anim/reveal';
import { gameOverCue } from '../../audio/soundPlan';
import { DurakReveal } from '../../moments/DurakReveal';
import { teamName, teamOf } from '../../game/teams';
import { MomentBanner } from '../../moments/MomentBanner';
import { championLine, TournamentActions, TournamentPill } from '../../tournament/TournamentPanel';
import { planChampionReveal } from '../../anim/championReveal';
import { ChampionReveal } from '../../moments/ChampionReveal';
import { tournamentLeave } from '../../tournament/tournament';
import { useMomentQueue } from '../../moments/useMomentQueue';

const GAME_ERRORS: ReadonlySet<string> = new Set(GAME_ERROR_CODES);
const LAST_BOUT_PEEK_MS = 2500;
/** Sources without quick reactions (the tutorial). */
const NO_REACTIONS: ReactionsInView = { enabled: false, byPlayer: new Map(), latest: null };

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

/** The game table. `source` drives it: a real room (`OnlineTable`) or the tutorial. */
export function TableScreen({ source }: { source: TableSource }) {
  const { game, room, gameOver, ratings, lastError, members, online, guide } = source;
  // Disconnected or re-binding the seat: moves would be dropped, so don't offer any.
  const reconnecting = source.reconnecting;
  // Selection belongs to one game version: any new state (ours or anyone's move) clears it.
  const [picked, setPicked] = useState<{ version: number; selection: Selection }>({ version: -1, selection: NO_SELECTION });
  const remaining = useCountdown(game, source.now);
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
  // The tournament's champion moment follows the reveal of the series' last game (one we watched end).
  const seriesOver = online && room?.tournament?.status === 'finished' ? room.tournament : null;
  const championPlan = useMemo(
    () => (game && gameFinished && sawRunning.current === game.gameId ? planChampionReveal(seriesOver, { reduced, speed }) : null),
    [game?.gameId, gameFinished, seriesOver?.id, seriesOver?.status, reduced],
  );
  const [championDoneFor, setChampionDoneFor] = useState<string | null>(null);

  // The screen stays on while the game runs (released when it ends, re-taken after the page was hidden).
  // (A local game, the tutorial, has no room: it runs while its game does.)
  useWakeLock(!!view && !gameFinished && (!online || room?.status === 'playing'));

  const soundTurn = !!view && viewerId !== null && !gameFinished && !reconnecting && moves.length > 0;
  useGameSounds({
    anim,
    myTurn: soundTurn,
    remaining,
    gameOver,
    viewerId,
    table: view ? { config: view.config, players: view.players } : undefined,
    stingerByReveal: revealPlan !== null,
  });
  const reactions = online?.reactions ?? NO_REACTIONS;
  const moment = useMomentQueue(anim, { speed, enabled: !!view && !gameFinished && !reconnecting });

  if (!game || !view) return null;

  const selection = picked.version === game.version ? picked.selection : NO_SELECTION;
  const nameOf = (id: string) => nicknameOf(id, members);
  const spectator = view.viewerId === null;
  const finished = view.phase.kind === 'finished' || room?.status === 'finished';
  // A guided lesson pauses the table while it shows feedback.
  const interactive = !spectator && !finished && !reconnecting && !guide?.blocked;
  const me = view.players.find((p) => p.id === view.viewerId);
  const myMember = me ? members?.find((m) => m.playerId === me.id) : undefined;
  // Seated players who still hold their seat (not spectators, not a seat a bot took over).
  const canReact = !!online && reactions.enabled && !!myMember && !myMember.leftGame && !myMember.isBot;
  const awaited = awaitedPlayers(view, interactive ? moves : []);
  const ringOf = (id: string): TurnRing => ({
    progress: !finished && awaited.has(id) ? (fraction ?? 1) : null,
    urgent: remaining !== null && remaining <= 5000 && awaited.has(id),
  });
  const myTurn = interactive && moves.length > 0;
  const effects = moment ? seatEffects(moment.moment) : null;
  const effectOf = (id: string): SeatEffectProp => (moment && effects?.has(id) ? { kind: effects.get(id)!, id: moment.id } : null);
  const revealing = finished && overlayReady && revealPlan !== null && revealDoneFor !== game.gameId;
  const championing = finished && overlayReady && !revealing && championPlan !== null && championDoneFor !== game.gameId;

  // First-game tips: shown for the current situation until dismissed or acted on once.
  // A short landscape screen has no room for them (they show in portrait and on bigger screens).
  const tip = settings.showTips && interactive && !short && !guide ? tipFor(view, moves, settings.tipsSeen) : null;
  const sendMove = (move: ClientMove) => {
    if (tip && tipLearnedBy(tip, move)) settingsStore.markTipSeen(tip);
    source.sendMove(move);
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
      className={`flex shrink-0 flex-wrap justify-center ${mode === 'phone' ? 'gap-1' : 'gap-1.5 sm:gap-2.5'}`}
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
          variant={mode === 'phone' ? 'compact' : 'regular'}
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
      onCardClick={(card: Card) => {
        if (!interactive) return;
        // A lesson explains a tap the table can't use (or takes it as a "pick").
        if (guide?.onHandTap?.(card, isPlayable(card, moves, selection))) return;
        apply(clickHandCard(card, moves, selection));
      }}
      {...(guide?.handCardState ? { cardState: guide.handCardState } : {})}
      short={short}
    />
  );

  // A tournament: the pill while a series game runs, the series' consequence in the leave confirm.
  const series = online ? (room?.tournament ?? null) : null;
  const seriesLeave = tournamentLeave(series ? room : null, viewerId);
  const leaveExtra = seriesLeave === 'bot' ? t.tournament.leaveBot : seriesLeave === 'ends' ? t.tournament.leaveEnds : null;
  const leaveButton = <LeaveButton outcome={source.leave.outcome} onLeave={source.leave.run} extra={leaveExtra} />;
  const tools = (
    <>
      {series && series.status === 'running' && room?.status === 'playing' && <TournamentPill tournament={series} />}
      {online && canProposeRestart(view, room) && <RestartButton disabled={!!room?.restartVote || reconnecting} />}
      <HelpButton />
      <SettingsButton />
    </>
  );
  const deckPile = <DeckPile view={view} small={short} highlightTrump={guide?.highlightTrump ?? false} />;
  const discardPile = <DiscardPile view={view} showLastBout={peek && view.table.length === 0} small={short} />;
  const overlays = (
    <>
      <FlightLayer key={flights.version} flights={flights.list} />
      <ReactionAnnouncer latest={reactions.latest} nameOf={nameOf} />
      <MomentBanner active={moment} viewerId={viewerId} nameOf={nameOf} reduced={reduced} />

      {revealing && revealPlan && (
        <DurakReveal
          plan={revealPlan}
          viewerId={viewerId}
          nameOf={nameOf}
          stinger={gameOver ? gameOverCue(gameOver, viewerId, view) : null}
          teamCaption={(() => {
            const losing = revealPlan.durakId !== null ? teamOf(view, revealPlan.durakId) : null;
            return losing === null ? null : t.teams.teamLostNamed(teamName(losing));
          })()}
          onDone={() => setRevealDoneFor(game.gameId)}
        />
      )}

      {championing && championPlan && seriesOver && (
        <ChampionReveal
          plan={championPlan}
          caption={championLine(seriesOver, nameOf, viewerId)}
          onDone={() => setChampionDoneFor(game.gameId)}
        />
      )}

      {finished && overlayReady && !revealing && !championing && gameOver?.endReason !== 'restarted' && (
        <GameOverOverlay
          view={view}
          gameOver={gameOver}
          nameOf={nameOf}
          canRematch={!spectator && !!online}
          {...(online ? { onRematch: online.rematch } : {})}
          {...(series && room
            ? {
                tournament: {
                  view: series,
                  actions:
                    series.status === 'running' && online ? (extra: ReactNode) => (
                      <TournamentActions
                        extra={extra}
                        room={room}
                        viewerId={viewerId}
                        roomReceivedAt={online.roomReceivedAt}
                        now={source.now}
                        nameOf={nameOf}
                        onNext={online.tournamentNext}
                        onEnd={online.tournamentEnd}
                        {...(!spectator ? { leave: leaveButton } : {})}
                      />
                    ) : null,
                },
              }
            : {})}
          {...(guide?.gameOverAction ? { action: guide.gameOverAction } : {})}
          reduced={reduced}
          reactions={reactions}
          canReact={canReact}
          ratings={ratings}
        />
      )}
    </>
  );
  // While the durak reveal runs, my side of the table slides away.
  const hideOnReveal = `transition duration-500 ${revealing || championing ? 'translate-y-24 opacity-0' : ''}`;

  if (short) {
    // Short landscape (a phone on its side): height is scarce, width is not. Three columns, each the
    // full height. In this RTL row the first child is on the right (inline-start), where Hebrew
    // reading starts: "leave" and who is at the table. The centre: the table, the hand under it. The
    // left (inline-end): the room tools, the piles, the status, my seat and Take/Pass (where they were).
    // The outer edges clear the notch / Dynamic Island, which sits on the left or the right in
    // landscape (--sai-*: the safe-area insets, index.css).
    return (
      <AnchorProvider registry={registry}>
        <LayoutGroup>
          <div
            className="relative flex min-h-0 w-full flex-1 flex-row gap-1.5 pt-1.5 pr-[max(var(--sai-right),0.5rem)] pb-[max(var(--sai-bottom),0.375rem)] pl-[max(var(--sai-left),0.5rem)]"
            data-layout={mode}
          >
            <aside className="flex w-28 shrink-0 flex-col gap-1.5" data-testid="seat-column">
              <div className="flex">
                {leaveButton}
              </div>
              <ul className="flex min-h-0 flex-1 flex-col justify-evenly gap-1" aria-label="opponents">
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
                    variant="inline"
                  />
                ))}
              </ul>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {online && <RestartVotePanel viewerId={view.viewerId} />}
              <section
                className="flex min-h-0 w-full flex-1 items-center rounded-table bg-gradient-to-b from-surface-2 to-surface p-1.5 shadow-table ring-1 ring-line"
                dir="ltr"
                data-testid="table-surface"
              >
                {tableArea}
              </section>
              {!spectator && me && <div className={`shrink-0 ${hideOnReveal}`}>{handFan}</div>}
            </div>

            <div className={`flex w-52 shrink-0 flex-col gap-1.5 ${hideOnReveal}`} data-testid="side-panel">
              <div className="flex items-center justify-end gap-1.5" data-testid="top-bar">
                {tools}
              </div>
              {/* The stock and the discard pile: the table gets the centre's full width. */}
              <div className="flex items-center justify-between gap-1 px-1" dir="ltr" data-testid="piles">
                {deckPile}
                {discardPile}
              </div>
              <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5">
                {guide?.panel}
                {/* With a lesson's guide the status line repeats it: the narrow side column keeps the guide. */}
                {!finished && !guide && status}
                {!spectator && me && (
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    {mySeat}
                    {interactive && <ActionBar moves={moves} onMove={send} compact />}
                  </div>
                )}
              </div>
            </div>
            {overlays}
          </div>
        </LayoutGroup>
      </AnchorProvider>
    );
  }

  return (
    <AnchorProvider registry={registry}>
      <LayoutGroup>
        {/* Exactly one screen tall (App sets h-dvh): the table takes what the other rows leave. */}
        <div
          className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 pt-2 pr-[max(var(--sai-right),0.5rem)] pl-[max(var(--sai-left),0.5rem)] sm:gap-3 sm:pt-3 sm:pr-[max(var(--sai-right),1rem)] sm:pl-[max(var(--sai-left),1rem)] [@media(max-height:820px)]:gap-2"
          data-layout={mode}
        >
          <TopBar leave={leaveButton} extra={tools} />
          {online && <RestartVotePanel viewerId={view.viewerId} />}
          {opponents}

          <section
            className={`mx-auto flex min-h-0 w-full flex-1 gap-2 rounded-table bg-gradient-to-b from-surface-2 to-surface p-2 shadow-table ring-1 ring-line sm:gap-4 sm:p-4 ${
              mode === 'phone' ? 'flex-col' : 'items-center'
            }`}
            dir="ltr"
            data-testid="table-surface"
          >
            {mode === 'phone' ? (
              // Phones: the stock and the discard pile become one small strip, the table gets the full width.
              <div className="flex shrink-0 items-center justify-between px-1" data-testid="piles">
                <DeckPile view={view} small highlightTrump={guide?.highlightTrump ?? false} />
                <DiscardPile view={view} showLastBout={peek && view.table.length === 0} small />
              </div>
            ) : (
              deckPile
            )}
            {tableArea}
            {mode !== 'phone' && discardPile}
          </section>

          {!finished && status}

          <div className={`flex shrink-0 flex-col items-center gap-1.5 pb-[var(--sai-bottom)] sm:gap-2 ${hideOnReveal}`}>
            {guide?.panel}
            {tip && <TipBanner tip={tip} onDismiss={() => settingsStore.markTipSeen(tip)} />}
            {!spectator && me && (
              <>
                {/* My seat and Take / Pass share the row ABOVE the hand: the buttons can never cover (or steal clicks from) a card. */}
                <div className="flex w-full max-w-xl items-center justify-between gap-2 px-1">
                  {mySeat}
                  {interactive && <ActionBar moves={moves} onMove={send} />}
                </div>
                {handFan}
              </>
            )}
          </div>
          {overlays}
        </div>
      </LayoutGroup>
    </AnchorProvider>
  );
}
