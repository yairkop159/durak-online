import { describe, expect, it } from 'vitest';
import { describeSelfPlay, playRandomGame } from './selfPlay.js';

describeSelfPlay('podkidnoy');

describe('self-play determinism', () => {
  it('the same seed and the same choices replay identically', () => {
    expect(playRandomGame(4, 'perevodnoy', 123)).toEqual(playRandomGame(4, 'perevodnoy', 123));
  });
});
