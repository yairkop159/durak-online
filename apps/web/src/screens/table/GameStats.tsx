import type { GameMode, GameStats, PlayerStats } from '@durak/shared';
import { useState } from 'react';
import { highlights, type Highlight } from '../../game/highlights';
import { t } from '../../i18n';

function highlightText(h: Highlight): { title: string; value: string } {
  const s = t.stats;
  switch (h.kind) {
    case 'mostTaken':
      return { title: s.mostTaken, value: s.mostTakenValue(h.value) };
    case 'bestDefense':
      return { title: s.bestDefense, value: h.of !== undefined ? s.bestDefenseValue(h.value, h.of) : String(h.value) };
    case 'mostTransfers':
      return { title: s.mostTransfers, value: s.mostTransfersValue(h.value) };
    case 'mostThrowIns':
      return { title: s.mostThrowIns, value: s.mostThrowInsValue(h.value) };
  }
}

type Column = Exclude<keyof typeof t.stats.columns, 'player'>;
const COLUMNS: readonly Column[] = ['boutsAttacked', 'defenses', 'cardsTaken', 'throwIns', 'transfers', 'cardsPlayed'];

/** Highlights ("most cards taken", "best defense"...) and a collapsible per-player table. */
export function GameStatsSection({
  stats,
  mode,
  players,
  nameOf,
}: {
  stats: GameStats;
  mode: GameMode;
  /** Seat order. */
  players: readonly string[];
  nameOf: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const list = highlights(stats, mode);
  const columns = COLUMNS.filter((c) => c !== 'transfers' || mode === 'perevodnoy');
  const rows = players.filter((id) => stats[id] !== undefined);
  if (rows.length === 0) return null;
  const cell = (s: PlayerStats, c: Column) => (c === 'defenses' ? `${s.defenses}/${s.boutsDefended}` : String(s[c]));

  return (
    <div className="flex w-full flex-col gap-2" data-testid="game-stats">
      {list.length > 0 && (
        <div className="w-full">
          <h3 className="mb-1.5 text-sm font-semibold">{t.stats.highlights}</h3>
          <ul className="grid grid-cols-2 gap-1.5 text-start">
            {list.map((h) => {
              const { title, value } = highlightText(h);
              return (
                <li key={h.kind} data-testid={`highlight-${h.kind}`} className="flex flex-col rounded-lg bg-white/5 px-2.5 py-1.5">
                  <span className="text-[11px] text-muted">{title}</span>
                  <span className="truncate text-sm font-bold">{h.players.map(nameOf).join(', ')}</span>
                  <span className="text-[11px] text-accent">{value}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="min-h-11 self-center px-3 text-xs font-semibold text-muted underline-offset-2 hover:underline"
      >
        {open ? t.stats.hideAll : t.stats.showAll}
      </button>
      {open && (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-testid="stats-table">
            <thead>
              <tr className="text-muted">
                <th className="px-1 py-1 text-start font-semibold">{t.stats.columns.player}</th>
                {columns.map((c) => (
                  <th key={c} className="px-1 py-1 font-semibold">
                    {t.stats.columns[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((id) => (
                <tr key={id} className="border-t border-line">
                  <td className="max-w-24 truncate px-1 py-1 text-start font-medium">{nameOf(id)}</td>
                  {columns.map((c) => (
                    <td key={c} className="px-1 py-1 text-center">
                      {cell(stats[id]!, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
