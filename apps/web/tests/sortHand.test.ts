import { describe, expect, it } from 'vitest';
import { sortHand } from '../src/game/sortHand';
import { cards } from './helpers';

describe('sortHand', () => {
  it('groups non-trumps by suit and rank, trumps last', () => {
    expect(sortHand(cards('AD 6H 9S 7D 6S KC 10H'), 'D')).toEqual(cards('6S 9S KC 6H 10H 7D AD'));
  });

  it('does not mutate the input', () => {
    const hand = cards('AS 6S');
    sortHand(hand, 'H');
    expect(hand).toEqual(cards('AS 6S'));
  });
});
