import type { Card, GamePhase, PlayerView } from '@durak/shared';
import { err, ok, type Result } from '../result.js';
import { shuffle, type Rng } from '../rng.js';
import type { GameState, PlayerState } from '../state.js';
import { cardFromId, unseenCards, type PublicKnowledge } from './knowledge.js';

export interface DeterminizeError {
  readonly code: 'INCONSISTENT_KNOWLEDGE';
  readonly message: string;
}

/**
 * Samples one complete hidden state consistent with the bot's view and knowledge (a "determinization").
 * The ONLY place in the bot that builds a `GameState`. The unseen cards are shuffled and dealt, in a
 * fixed order: each opponent (seat order) gets their known cards plus enough unseen cards to match
 * their hand count, then the stock (the face-up trump stays at the bottom), then the part of the
 * discard pile we cannot identify. Re-sanitizing the result for the viewer yields `view` again.
 */
export function sampleWorld(
  view: PlayerView,
  knowledge: PublicKnowledge,
  rng: Rng,
): Result<GameState, DeterminizeError> {
  const fail = (message: string) => err<DeterminizeError>({ code: 'INCONSISTENT_KNOWLEDGE', message });
  const me = view.viewerId;
  if (me === null) return fail('Spectator views cannot be determinized');

  const unseen = shuffle(unseenCards(knowledge, view), rng);
  let cursor = 0;
  const take = (n: number): Card[] | null => {
    if (n < 0 || cursor + n > unseen.length) return null;
    const out = unseen.slice(cursor, cursor + n);
    cursor += n;
    return out;
  };

  const players: PlayerState[] = [];
  for (const p of view.players) {
    if (p.id === me) {
      players.push({ id: p.id, hand: view.hand.slice() });
      continue;
    }
    const known = (knowledge.knownHands[p.id] ?? []).map(cardFromId);
    const rest = take(p.handCount - known.length);
    if (!rest) return fail(`Cannot fill ${p.id}'s hand`);
    players.push({ id: p.id, hand: [...known, ...rest] });
  }

  let deck: Card[] = [];
  if (view.deckCount > 0) {
    const stock = take(view.deckCount - 1);
    if (!stock) return fail('Cannot fill the stock');
    deck = [...stock, view.trumpCard];
  }

  const unknownDiscard = take(view.discardCount - knowledge.discard.length);
  if (!unknownDiscard) return fail('Cannot fill the discard pile');
  if (cursor !== unseen.length) return fail(`${unseen.length - cursor} unseen cards left over`);

  const phase: GamePhase =
    view.phase.kind === 'bout'
      ? { kind: 'bout', taking: view.phase.taking, passed: [...view.phase.passed] }
      : { ...view.phase };
  const attackerIndex = view.players.findIndex((p) => p.id === view.attackerId);
  const defenderIndex = view.players.findIndex((p) => p.id === view.defenderId);
  if (attackerIndex === -1 || defenderIndex === -1) return fail('Unknown attacker or defender');

  return ok({
    config: { ...view.config },
    players,
    deck,
    trumpCard: view.trumpCard,
    discard: [...knowledge.discard.map(cardFromId), ...unknownDiscard],
    table: view.table.map((p) => ({ attack: p.attack, defense: p.defense })),
    attackerIndex,
    defenderIndex,
    phase,
    boutNumber: view.boutNumber,
    finishOrder: [...view.finishOrder],
    lastBout: view.lastBout,
  });
}
