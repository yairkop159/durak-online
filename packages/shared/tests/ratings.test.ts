import { describe, expect, it } from 'vitest';
import { GameRatingsPayloadSchema, ServerEvents, ratingEntry } from '../src/index.js';

const base = { roomId: 'room1234', gameId: 'g1' };

describe('GameRatingsPayloadSchema', () => {
  it('accepts pending, unrated (with a reason) and rated (with entries)', () => {
    expect(GameRatingsPayloadSchema.safeParse({ ...base, status: 'pending' }).success).toBe(true);
    expect(GameRatingsPayloadSchema.safeParse({ ...base, status: 'unrated', reason: 'notEnoughProfiles' }).success).toBe(true);
    expect(GameRatingsPayloadSchema.safeParse({ ...base, status: 'unrated', reason: 'notFinished' }).success).toBe(true);
    const rated = { ...base, status: 'rated', entries: [ratingEntry('a', 1000, 1016), ratingEntry('b', 1000, 984)] };
    expect(GameRatingsPayloadSchema.safeParse(rated).success).toBe(true);
  });

  it('rejects a delta that does not match before/after, unknown reasons, missing entries and extra fields', () => {
    const bad = [
      { ...base, status: 'rated', entries: [{ playerId: 'a', before: 1000, after: 1016, delta: 99 }, ratingEntry('b', 1000, 984)] },
      { ...base, status: 'rated', entries: [ratingEntry('a', 1000, 1016)] },
      { ...base, status: 'rated' },
      { ...base, status: 'unrated', reason: 'because' },
      { ...base, status: 'pending', extra: 1 },
      { ...base, status: 'done' },
      { roomId: 'x', gameId: 'g1', status: 'pending' },
    ];
    for (const payload of bad) expect(GameRatingsPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('is a server event', () => {
    expect(ServerEvents.GameRatings).toBe('game:ratings');
  });
});
