import { describe, expect, it } from 'vitest';
import { getLegalMoves } from '../src/index.js';
import { c, cards, expectError, handOf, idOf, makeState, play, type StateSpec } from './helpers.js';

// Trump suit: diamonds (bottom card AD).
const perevodnoy = (spec: Partial<StateSpec> & Pick<StateSpec, 'hands'>) =>
  makeState({ deck: 'QH KH AD', attacker: 'a', ...spec, config: { mode: 'perevodnoy', ...spec.config } });

describe('transfer (perevodnoy)', () => {
  it('is not allowed in podkidnoy mode', () => {
    const s0 = makeState({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' }, deck: 'QH AD', attacker: 'a' });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'transfer', playerId: 'b', card: c('6H') }, 'TRANSFER_NOT_ALLOWED');
  });

  it('passes the bout to the next player, who becomes the defender', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    expect(s.table.map((p) => p.attack)).toEqual(cards('6S 6H'));
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('c');
    expect(handOf(s, 'b')).toEqual(cards('7H 8C'));
    expect(s.phase).toEqual({ kind: 'bout', taking: false, passed: [] });
  });

  it('requires the transfer card to match the attack rank', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' } });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'transfer', playerId: 'b', card: c('7H') }, 'TRANSFER_NOT_ALLOWED');
  });

  it('is not allowed once any card has been covered', () => {
    const s0 = perevodnoy({ hands: { a: '6S 6C 9C', b: '6H 7S 8C', c: '10S JS QS' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'attack', playerId: 'a', card: c('6C') });
    s = play(s, { type: 'defend', playerId: 'b', attackIndex: 0, card: c('7S') });
    expectError(s, { type: 'transfer', playerId: 'b', card: c('6H') }, 'TRANSFER_NOT_ALLOWED');
  });

  it('is not allowed if the next player holds fewer cards than would be on the table', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S' } });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'transfer', playerId: 'b', card: c('6H') }, 'TRANSFER_NOT_ALLOWED');
  });

  it('respects the bout card limit', () => {
    const s0 = perevodnoy({
      hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' },
      boutNumber: 1,
      config: { firstBoutMaxCards: 1 },
    });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    expectError(s, { type: 'transfer', playerId: 'b', card: c('6H') }, 'TRANSFER_NOT_ALLOWED');
  });

  it('can be chained around the table', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C 10C JC', b: '6H 7H 8C', c: '6C JS QS' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    s = play(s, { type: 'transfer', playerId: 'c', card: c('6C') });
    expect(idOf(s, s.attackerIndex)).toBe('c');
    expect(idOf(s, s.defenderIndex)).toBe('a');
    expect(s.table).toHaveLength(3);
  });

  it('in a two-player game the attack bounces back to the original attacker', () => {
    const s0 = perevodnoy({ hands: { a: '6S 7D 8D', b: '6H 8C 9C' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    expect(idOf(s, s.attackerIndex)).toBe('b');
    expect(idOf(s, s.defenderIndex)).toBe('a');
  });

  it('after a transfer the previous attackers may throw in against the new defender', () => {
    const s0 = perevodnoy({ hands: { a: '6S 6C 9C', b: '6H 7H 8C', c: '10S JS QS' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    s = play(s, { type: 'attack', playerId: 'a', card: c('6C') });
    expect(s.table).toHaveLength(3);
    // c holds exactly 3 cards: no more room.
    expect(getLegalMoves(s, 'a').filter((m) => m.type === 'attack')).toEqual([]);
  });

  it('if the new defender takes, the player after them attacks next', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' } });
    let s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    s = play(s, { type: 'transfer', playerId: 'b', card: c('6H') });
    s = play(s, { type: 'take', playerId: 'c' });
    expect(handOf(s, 'c')).toEqual(cards('10S JS QS 6S 6H'));
    expect(idOf(s, s.attackerIndex)).toBe('a');
    expect(idOf(s, s.defenderIndex)).toBe('b');
    // Draw order started with the transferring player (b), then a, then the taker.
    expect(handOf(s, 'b')).toEqual(cards('7H 8C QH KH AD'));
    expect(handOf(s, 'a')).toEqual(cards('9C'));
  });

  it('getLegalMoves offers the transfer only when it is legal', () => {
    const s0 = perevodnoy({ hands: { a: '6S 9C', b: '6H 7H 8C', c: '10S JS QS' } });
    const s = play(s0, { type: 'attack', playerId: 'a', card: c('6S') });
    const transfers = getLegalMoves(s, 'b').filter((m) => m.type === 'transfer');
    expect(transfers).toEqual([{ type: 'transfer', playerId: 'b', card: c('6H') }]);
  });
});
