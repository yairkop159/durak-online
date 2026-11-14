import type { GameMode, GameStats, PlayerStats } from '@durak/shared';

/** Game-over highlights from the end-of-game stats (pure). */
export type HighlightKind = 'mostTaken' | 'bestDefense' | 'mostTransfers' | 'mostThrowIns';

export interface Highlight {
  readonly kind: HighlightKind;
  /** Everyone tied for it. */
  readonly players: readonly string[];
  readonly value: number;
  /** For bestDefense: bouts defended (the value is successful defenses). */
  readonly of?: number;
}

function leaders(stats: GameStats, score: (s: PlayerStats) => number): { players: string[]; value: number } {
  let best = 0;
  let players: string[] = [];
  for (const [id, s] of Object.entries(stats)) {
    const v = score(s);
    if (v > best) {
      best = v;
      players = [id];
    } else if (v === best && v > 0) {
      players.push(id);
    }
  }
  return { players, value: best };
}

/**
 * Each highlight appears only when someone scored above 0. Best defense: the most successful
 * defenses; a tie goes to the best success rate (still tied: everyone tied). Transfers only in
 * perevodnoy. Order of `stats` keys (seat order) breaks nothing: ties list every leader.
 */
export function highlights(stats: GameStats, mode: GameMode): Highlight[] {
  const out: Highlight[] = [];
  const taken = leaders(stats, (s) => s.cardsTaken);
  if (taken.value > 0) out.push({ kind: 'mostTaken', ...taken });

  const defense = leaders(stats, (s) => s.defenses);
  if (defense.value > 0) {
    const rate = (id: string) => stats[id]!.defenses / Math.max(1, stats[id]!.boutsDefended);
    const bestRate = Math.max(...defense.players.map(rate));
    const players = defense.players.filter((id) => rate(id) === bestRate);
    const of = stats[players[0]!]!.boutsDefended;
    const sameOf = players.every((id) => stats[id]!.boutsDefended === of);
    out.push({ kind: 'bestDefense', players, value: defense.value, ...(sameOf ? { of } : {}) });
  }

  if (mode === 'perevodnoy') {
    const transfers = leaders(stats, (s) => s.transfers);
    if (transfers.value > 0) out.push({ kind: 'mostTransfers', ...transfers });
  }
  const throwIns = leaders(stats, (s) => s.throwIns);
  if (throwIns.value > 0) out.push({ kind: 'mostThrowIns', ...throwIns });
  return out;
}
