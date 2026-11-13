import type { ClientMove, PlayerView, PublicPlayer, RoomMember } from '@durak/shared';
import { Button, Pill } from '../../components/ui';
import { t } from '../../i18n';
import type { ReactNode } from 'react';
import { secondsLeft } from '../../net/clock';
import { BotPill } from '../../components/BotPill';

/** Role/status pills shared by opponents and the viewer's own strip (labels, not buttons). */
export function PlayerBadges({ player, view, member }: { player: PublicPlayer; view: PlayerView; member?: RoomMember | undefined }) {
  const phase = view.phase;
  const playing = phase.kind !== 'finished';
  return (
    <span className="flex flex-wrap items-center justify-center gap-1">
      {playing && !player.finished && view.attackerId === player.id && <Pill tone="attack">{t.table.attacker}</Pill>}
      {playing && !player.finished && view.defenderId === player.id && <Pill tone="defend">{t.table.defender}</Pill>}
      {phase.kind === 'bout' && phase.passed.includes(player.id) && <Pill tone="muted">{t.table.passed}</Pill>}
      {player.finished && <Pill tone="accent">{t.table.out}</Pill>}
      {member?.isBot && <BotPill member={member} />}
      {member && !member.isBot && !member.connected && <Pill tone="muted">{t.table.offline}</Pill>}
      {/* An AFK human is played by the bot until they act again. */}
      {member && !member.isBot && member.afk && playing && !player.finished && (
        <Pill tone="warn">{view.viewerId === player.id ? t.bots.playingForYou : t.bots.playingForThem}</Pill>
      )}
    </span>
  );
}

/**
 * Take / Pass: big solid buttons in their own row above the hand (never overlapping it).
 * The row keeps its height when there is nothing to press, so the hand never jumps.
 */
export function ActionBar({ moves, onMove }: { moves: readonly ClientMove[]; onMove: (move: ClientMove) => void }) {
  const take = moves.find((m) => m.type === 'take');
  const pass = moves.find((m) => m.type === 'pass');
  if (!take && !pass) return <div aria-hidden="true" data-testid="action-row" className="min-h-12 w-full" />;
  return (
    <div
      role="toolbar"
      aria-label={t.table.actions}
      data-testid="action-row"
      className="relative z-20 flex min-h-12 w-full justify-center gap-3 px-4"
    >
      {take && (
        <Button variant="danger" size="lg" className="min-w-36 flex-1 sm:flex-none" onClick={() => onMove(take)}>
          {t.table.take}
        </Button>
      )}
      {pass && (
        <Button variant="primary" size="lg" className="min-w-36 flex-1 sm:flex-none" onClick={() => onMove(pass)}>
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
export function StatusBanner({ text, myTurn, countdown }: { text: string; myTurn: boolean; countdown: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className={`mx-auto flex max-w-xl items-center justify-center gap-3 rounded-pill px-4 py-2 text-sm font-semibold ring-1 transition-colors duration-300 ${
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
