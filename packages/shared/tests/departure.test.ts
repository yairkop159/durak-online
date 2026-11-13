import { describe, expect, it } from 'vitest';
import { departureKind, type DepartureSeat } from '../src/index.js';

const human = (playerId: string, isOut = false): DepartureSeat => ({ playerId, isHuman: true, isOut });
const bot = (playerId: string, isOut = false): DepartureSeat => ({ playerId, isHuman: false, isOut });

describe('departureKind', () => {
  it('is none when no game is running', () => {
    expect(departureKind({ running: false, leaverId: 'a', seats: [human('a'), human('b'), human('c')] })).toBe('none');
  });

  it('is none when the leaver already went out', () => {
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a', true), human('b'), human('c')] })).toBe(
      'none',
    );
  });

  it('always resigns in a 2-player game, against a human or a bot', () => {
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a'), human('b')] })).toBe('resign');
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a'), bot('b')] })).toBe('resign');
  });

  it('takes over in 3+ player games while another human is still in', () => {
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a'), human('b'), bot('c')] })).toBe('takeover');
  });

  it('resigns in 3+ player games when no other human is still in', () => {
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a'), bot('b'), bot('c')] })).toBe('resign');
    expect(departureKind({ running: true, leaverId: 'a', seats: [human('a'), human('b', true), bot('c')] })).toBe(
      'resign',
    );
  });
});
