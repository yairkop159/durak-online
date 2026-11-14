import type { GameState } from '@durak/game-engine';
import { EMPTY_PLAYER_STATS, STAT_KEYS, type GameStats, type PlayerId, type PlayerStats } from '@durak/shared';
import { gameEvents, type GameEvent } from './gameEvents.js';

type MutableStats = { -readonly [K in keyof PlayerStats]: number };

/** Zeros for every seat (a new game). */
export function initialStats(state: GameState): GameStats {
  return Object.fromEntries(state.players.map((p) => [p.id, { ...EMPTY_PLAYER_STATS }]));
}

/** What one step adds, from its public events (see gameEvents). */
export function statsDelta(events: readonly GameEvent[]): GameStats {
  const out: Record<PlayerId, MutableStats> = {};
  const of = (id: PlayerId): MutableStats => (out[id] ??= { ...EMPTY_PLAYER_STATS });
  for (const e of events) {
    if (e.type === 'played') {
      const s = of(e.by);
      s.cardsPlayed++;
      if (e.role === 'open') s.boutsAttacked++;
      else if (e.role === 'throwIn') s.throwIns++;
      else if (e.role === 'transfer') s.transfers++;
    } else if (e.type === 'resolved') {
      const s = of(e.defenderId);
      s.boutsDefended++;
      if (e.outcome === 'beaten') s.defenses++;
      else {
        s.takes++;
        s.cardsTaken += e.cards;
      }
    }
  }
  return out;
}

export function addStats(a: GameStats, b: GameStats): GameStats {
  const out: Record<PlayerId, PlayerStats> = { ...a };
  for (const [id, delta] of Object.entries(b)) {
    const base = a[id] ?? EMPTY_PLAYER_STATS;
    const sum: MutableStats = { ...base };
    for (const k of STAT_KEYS) sum[k] = base[k] + delta[k];
    out[id] = sum;
  }
  return out;
}

/** The stats after one committed step from `prev` to `next`. */
export function advanceStats(stats: GameStats, prev: GameState, next: GameState): GameStats {
  return addStats(stats, statsDelta(gameEvents(prev, next)));
}
