import type { ClientMove, PlayerView, PublicPlayer, RoomMember } from '@durak/shared';
import { Button, Pill } from '../../components/ui';
import { t } from '../../i18n';
import type { ReactNode } from 'react';
import { secondsLeft } from '../../net/clock';
import { BotPill } from '../../components/BotPill';

/** Role/status pills shared by opponents and the viewer's own strip (labels, not buttons). */
export function PlayerBadges({
  player,
  view,
  member,
  compact = false,
}: {
  player: PublicPlayer;
  view: PlayerView;
  member?: RoomMember | undefined;
  /** Small seats: one line, clipped (never taller than one pill). */
  compact?: boolean;
}) {
  const phase = view.phase;
  const playing = phase.kind !== 'finished';
  return (
    <span className={`flex items-center justify-center gap-1 ${compact ? 'max-w-full flex-nowrap overflow-hidden' : 'flex-wrap'}`}>
      {playing && !player.finished && view.attackerId === player.id && <Pill tone="attack">{t.table.attacker}</Pill>}
      {playing && !player.finished && view.defenderId === player.id && <Pill tone="defend">{t.table.defender}</Pill>}
      {phase.kind === 'bout' && phase.passed.includes(player.id) && <Pill tone="muted">{t.table.passed}</Pill>}
      {player.finished && <Pill tone="accent">{t.table.out}</Pill>}
      {member?.leftGame && <Pill tone="warn">{t.table.left}</Pill>}
      {member?.isBot && <BotPill member={member} />}
      {member && !member.isBot && !member.leftGame && !member.connected && <Pill tone="muted">{t.table.offline}</Pill>}
      {/* An AFK human is played by the bot until they act again. */}
      {member && !member.isBot && member.afk && playing && !player.finished && (
        <Pill tone="warn">{view.viewerId === player.id ? t.bots.playingForYou : t.bots.playingForThem}</Pill>
      )}
    </span>
  );
}

/**
 * Take / Pass: big solid buttons in the row above the hand, beside my seat (never overlapping a card).
 * The slot keeps its height when there is nothing to press, so the hand never jumps.
 */
export function ActionBar({
  moves,
  onMove,
  compact = false,
}: {
  moves: readonly ClientMove[];
  onMove: (move: ClientMove) => void;
  /** Beside my seat on a short screen: narrower buttons (still 48 px tall). */
  compact?: boolean;
}) {
  const width = compact ? 'min-w-24 px-4' : 'min-w-32 sm:min-w-36';
  const take = moves.find((m) => m.type === 'take');
  const pass = moves.find((m) => m.type === 'pass');
  if (!take && !pass) return <div aria-hidden="true" data-testid="action-row" className="min-h-12" />;
  return (
    <div
      role="toolbar"
      aria-label={t.table.actions}
      data-testid="action-row"
      className="relative z-20 flex min-h-12 shrink-0 justify-center gap-2"
    >
      {take && (
        <Button variant="danger" size="lg" className={width} onClick={() => onMove(take)}>
          {t.table.take}
        </Button>
      )}
      {pass && (
        <Button variant="primary" size="lg" className={width} onClick={() => onMove(pass)}>
          {t.table.pass}
        </Button>
      )}
    </div>
  );
}

/** Seconds left as a chip: neutral, amber under half, red in the last 5 s. */
export function Countdown({ ms, fraction }: { ms: number | null; fraction: number | null }) {
  if (ms === null) return null;
  const seconds = secondsLeft(ms);
  const tone =
    seconds <= 5 ? 'bg-danger/20 text-danger ring-danger/50' : (fraction ?? 1) < 0.5 ? 'bg-warn/15 text-warn ring-warn/40' : 'bg-white/6 text-text ring-line';
  return (
    <span data-testid="countdown" className={`min-w-14 rounded-pill px-2.5 py-0.5 text-center text-sm font-bold tabular-nums ring-1 ${tone}`}>
      {t.table.secondsLeft(seconds)}
    </span>
  );
}

/** One line telling the viewer what is going on; turquoise when it's their move. */
export function StatusBanner({
  text,
  myTurn,
  countdown,
  compact = false,
}: {
  text: string;
  myTurn: boolean;
  countdown: ReactNode;
  /** Beside the hand on a short screen: smaller and less rounded. */
  compact?: boolean;
}) {
  return (
    <div
      aria-live="polite"
      className={`mx-auto flex max-w-xl items-center justify-center font-semibold ${
        compact ? 'w-full gap-2 rounded-xl px-2.5 py-1 text-xs' : 'gap-3 rounded-pill px-4 py-1.5 text-[13px] sm:py-2 sm:text-sm'
      } ring-1 transition-colors duration-300 ${
        myTurn ? 'bg-accent/12 text-accent ring-accent/40 shadow-[0_0_24px_rgb(45_212_191/0.18)]' : 'bg-surface/70 text-text/90 ring-line'
      }`}
    >
      {myTurn && <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />}
      <span data-testid="status" className="text-center">
        {text}
      </span>
      {countdown}
    </div>
  );
}
