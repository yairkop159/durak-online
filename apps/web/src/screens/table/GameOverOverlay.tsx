import { isTeamGame, type GameOverPayload, type PlayerView, type TournamentView } from '@durak/shared';
import { TEAM_TEXT, teamName, teamOf, viewerResult } from '../../game/teams';
import { motion } from 'motion/react';
import { useMemo, type ReactNode } from 'react';
import { SUIT_SYMBOL } from '../../components/cards/PlayingCard';
import { Avatar, Button, Panel } from '../../components/ui';
import { t } from '../../i18n';
import type { ClientRatings } from '../../net/store';
import { entriesById } from '../../game/ratingDelta';
import { navigate } from '../../routing';
import { motionTokens as M } from '../../theme/motion';
import { ReactionButton } from '../../reactions/ReactionPicker';
import type { ReactionsInView } from '../../reactions/useReactions';
import { GameStatsSection } from './GameStats';
import { RatingResult } from './RatingResult';
import { TournamentSummary } from '../../tournament/TournamentPanel';

type Mood = 'celebrate' | 'durak' | 'neutral';

/**
 * The result. `game:over` carries the end reason; after a reload only the finished view is
 * re-sent, so without it we fall back to the durak recorded in the view.
 */
export function GameOverOverlay({
  view,
  gameOver,
  nameOf,
  canRematch,
  reduced = false,
  reactions = null,
  canReact = false,
  ratings = null,
  onRematch,
  action,
  tournament = null,
}: {
  view: PlayerView;
  gameOver: GameOverPayload | null;
  /** The rating outcome (game:ratings) of this game, if any. */
  ratings?: ClientRatings | null;
  nameOf: (id: string) => string;
  canRematch: boolean;
  /** "Back to the lobby" (a real room). */
  onRematch?: () => void;
  /** Replaces rematch / home as the main action (the tutorial: back to its menu). */
  action?: { readonly label: string; readonly run: () => void };
  reduced?: boolean;
  /** Reactions keep flowing on the result screen ("עוד סיבוב?"). */
  reactions?: ReactionsInView | null;
  canReact?: boolean;
  /**
   * The room's series: its standings are shown, and between games `actions` (next game / end /
   * waiting, leave) replace "back to the lobby". Once the series is over, back to the lobby ends it.
   */
  tournament?: { readonly view: TournamentView; readonly actions: ((extra: ReactNode) => ReactNode) | null } | null;
}) {
  const durak = gameOver ? gameOver.durakId : view.phase.kind === 'finished' ? view.phase.durak : null;
  const reason = gameOver?.endReason ?? 'normal';
  const finishOrder = gameOver?.finishOrder ?? view.finishOrder;
  // The forfeiting durak is already the headline; list the others who left (a bot finished for them).
  const forfeits = (gameOver?.forfeits ?? []).filter((id) => !(reason === 'forfeit' && id === durak));

  let headline: string;
  if (reason === 'abandoned') headline = t.gameOver.abandoned;
  else if (reason === 'forfeit' && durak !== null) headline = t.gameOver.forfeit(nameOf(durak));
  else if (durak === null) headline = t.gameOver.draw;
  else if (durak === view.viewerId) headline = t.gameOver.youAreDurak;
  else headline = t.gameOver.durak(nameOf(durak));

  // 2v2: the headline is the team result; the durak (or the forfeit) moves to the line under it.
  const result = viewerResult(view, durak);
  const losing = durak !== null && isTeamGame(view.config) && reason !== 'abandoned' ? teamOf(view, durak) : null;
  let durakLine: string | null = null;
  if (losing !== null && durak !== null) {
    durakLine = headline;
    headline = result === 'won' ? t.teams.teamWon : result === 'lost' ? t.teams.teamLost : t.teams.teamLostNamed(teamName(losing));
  }

  // The stats table carries the others' rating changes; without it (after a reload) they get a list.
  const statsShown = gameOver !== null && reason !== 'abandoned' && Object.keys(gameOver.stats).length > 0;
  const seatOrder = view.players.map((p) => p.id);

  const mood: Mood =
    reason === 'abandoned' ? 'neutral' : result === 'lost' || (durak !== null && durak === view.viewerId) ? 'durak' : 'celebrate';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg-0/70 p-safe-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-over-title"
    >
      {mood === 'celebrate' && !reduced && <Confetti />}
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={reduced ? { duration: M.reducedFadeMs / 1000 } : { type: 'spring', stiffness: 260, damping: 20 }}
        className="max-h-[92dvh] w-full max-w-sm overflow-y-auto"
      >
        <Panel className="flex flex-col items-center gap-4 text-center">
          <h2 id="game-over-title" className="text-sm font-semibold tracking-wide text-muted">
            {t.gameOver.title}
          </h2>
          {durak !== null && (
            <motion.div
              animate={mood === 'durak' && !reduced ? { rotate: [0, -8, 8, -5, 5, 0] } : {}}
              transition={{ delay: 0.45, duration: 0.7 }}
            >
              <Avatar id={durak} name={nameOf(durak)} size={56} />
            </motion.div>
          )}
          <motion.p
            data-testid="game-over-headline"
            initial={reduced ? false : { scale: 2.2, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: mood === 'durak' ? -4 : 0 }}
            transition={{ delay: 0.15, duration: M.gameOverStampMs / 1000, type: 'spring', stiffness: 380, damping: 18 }}
            className={`rounded-xl px-3 py-1 text-2xl font-black ${
              mood === 'durak' ? 'text-danger ring-2 ring-danger/70' : mood === 'celebrate' ? 'text-accent' : 'text-warn'
            }`}
          >
            {headline}
          </motion.p>
          {durakLine !== null && losing !== null && (
            <p data-testid="game-over-durak" className="-mt-2 text-base font-bold">
              <span className={TEAM_TEXT[losing]}>{teamName(losing)}</span>
              <span className="text-muted"> · </span>
              {durakLine}
            </p>
          )}
          <p className="text-xs text-muted">{t.gameOver.reasons[reason]}</p>
          <RatingResult ratings={ratings} viewerId={view.viewerId} seatOrder={seatOrder} nameOf={nameOf} showOthers={!statsShown} />
          {tournament && <TournamentSummary tournament={tournament.view} nameOf={nameOf} viewerId={view.viewerId} />}
          {finishOrder.length > 0 && (
            <div className="w-full">
              <h3 className="mb-1.5 text-sm font-semibold">{t.gameOver.finishOrder}</h3>
              <ol className="flex flex-col gap-1 text-sm">
                {finishOrder.map((id, i) => (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1">
                    <span className="w-4 font-bold text-accent tabular-nums">{i + 1}</span>
                    <span>{nameOf(id)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {forfeits.length > 0 && (
            <p className="text-sm text-warn" data-testid="game-over-forfeits">
              {t.gameOver.forfeits}: {forfeits.map(nameOf).join(', ')}
            </p>
          )}
          {statsShown && (
            <GameStatsSection stats={gameOver.stats} mode={view.config.mode} players={seatOrder} nameOf={nameOf} ratings={entriesById(ratings)} />
          )}
          {reactions && reactions.byPlayer.size > 0 && (
            <ul className="pointer-events-none flex flex-wrap justify-center gap-1.5" data-testid="game-over-reactions" aria-hidden="true">
              {[...reactions.byPlayer.values()].map((r) => (
                <li key={r.id} className="rounded-pill bg-white/8 px-2 py-0.5 text-sm">
                  {nameOf(r.playerId)}: {t.reactions.items[r.reactionId].text}
                </li>
              ))}
            </ul>
          )}
          {/* The actions stay in view while the stats scroll (a short landscape phone). */}
          <div className="sticky bottom-0 -mx-5 -mb-5 flex w-[calc(100%+2.5rem)] flex-col items-center gap-3 rounded-b-[22px] bg-surface px-5 pt-2 pb-5" data-testid="game-over-actions">
            {/* Between series games the reaction button shares the actions' row (short phones). */}
            {canReact && !tournament?.actions && <ReactionButton />}
            {action ? (
              <Button size="lg" className="w-full" onClick={action.run}>
                {action.label}
              </Button>
            ) : tournament?.actions ? (
              tournament.actions(canReact ? <ReactionButton /> : null)
            ) : canRematch && onRematch ? (
              <Button size="lg" className="w-full" onClick={onRematch}>
                {t.gameOver.backToLobby}
              </Button>
            ) : (
              <Button variant="secondary" className="w-full" onClick={() => navigate('/')}>
                {t.common.backHome}
              </Button>
            )}
          </div>
        </Panel>
      </motion.div>
    </div>
  );
}

const CONFETTI_COLORS = ['#2dd4bf', '#a78bfa', '#f59e0b', '#fb7185', '#38bdf8', '#e6edf7'];
const SUITS = Object.values(SUIT_SYMBOL);

/** ~24 suits and chips bursting up and falling; purely decorative. */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        // Deterministic spread (no Math.random needed for decoration).
        const a = (i * 137.5) % 360;
        return {
          x: Math.cos((a * Math.PI) / 180) * (120 + (i % 5) * 30),
          up: -160 - (i % 4) * 50,
          rotate: (i % 2 ? 1 : -1) * (180 + i * 20),
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
          glyph: i % 3 === 0 ? SUITS[i % 4]! : null,
          delay: (i % 6) * 0.03,
        };
      }),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" aria-hidden="true">
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          className="absolute text-lg font-black"
          style={{ color: p.color }}
          initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
          animate={{ x: p.x, y: [0, p.up, p.up + 420], opacity: [0, 1, 1, 0], rotate: p.rotate }}
          transition={{
            duration: M.confettiMs / 1000,
            delay: p.delay,
            ease: 'easeOut',
            y: { duration: M.confettiMs / 1000, delay: p.delay, times: [0, 0.35, 1], ease: ['easeOut', 'easeIn'] },
            opacity: { duration: M.confettiMs / 1000, delay: p.delay, times: [0, 0.1, 0.7, 1] },
          }}
        >
          {p.glyph ?? <span className="block h-2 w-3 rounded-[2px]" style={{ background: p.color }} />}
        </motion.span>
      ))}
    </div>
  );
}
