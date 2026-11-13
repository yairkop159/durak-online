import type { PlayerId, PlayerView } from '@durak/shared';
import type { GameState } from './state.js';

/**
 * Projects the authoritative state onto what `viewerId` may see.
 * Opponents' hands collapse to counts; the stock and discard pile collapse to counts.
 * Pass `null` (or an id that is not seated) for a spectator view with no hand.
 */
export function sanitizeStateForPlayer(state: GameState, viewerId: PlayerId | null): PlayerView {
  const viewer = viewerId === null ? undefined : state.players.find((p) => p.id === viewerId);
  const phase = state.phase;
  return {
    viewerId: viewer?.id ?? null,
    hand: viewer ? viewer.hand.map((c) => ({ suit: c.suit, rank: c.rank })) : [],
    players: state.players.map((p) => ({
      id: p.id,
      handCount: p.hand.length,
      finished: state.finishOrder.includes(p.id),
    })),
    deckCount: state.deck.length,
    trumpCard: { suit: state.trumpCard.suit, rank: state.trumpCard.rank },
    trumpSuit: state.trumpCard.suit,
    discardCount: state.discard.length,
    table: state.table.map((p) => ({
      attack: { suit: p.attack.suit, rank: p.attack.rank },
      defense: p.defense ? { suit: p.defense.suit, rank: p.defense.rank } : null,
    })),
    attackerId: state.players[state.attackerIndex]?.id ?? '',
    defenderId: state.players[state.defenderIndex]?.id ?? '',
    phase:
      phase.kind === 'bout'
        ? { kind: 'bout', taking: phase.taking, passed: [...phase.passed] }
        : { ...phase },
    boutNumber: state.boutNumber,
    finishOrder: [...state.finishOrder],
    config: { ...state.config },
    lastBout: state.lastBout
      ? {
          table: state.lastBout.table.map((p) => ({
            attack: { suit: p.attack.suit, rank: p.attack.rank },
            defense: p.defense ? { suit: p.defense.suit, rank: p.defense.rank } : null,
          })),
          outcome: state.lastBout.outcome,
          defenderId: state.lastBout.defenderId,
        }
      : null,
  };
}
