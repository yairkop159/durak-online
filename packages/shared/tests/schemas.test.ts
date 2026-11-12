import { describe, expect, it } from 'vitest';
import {
  ClientEventSchemas,
  ClientEvents,
  ClientMoveSchema,
  CreateRoomPayloadSchema,
  GameConfigInputSchema,
  MakeMovePayloadSchema,
  ResumeSessionPayloadSchema,
  cardId,
} from '../src/index.js';

describe('ClientMoveSchema', () => {
  it('accepts every well-formed move type', () => {
    const moves = [
      { type: 'attack', card: { suit: 'S', rank: 6 } },
      { type: 'defend', attackIndex: 2, card: { suit: 'H', rank: 14 } },
      { type: 'transfer', card: { suit: 'D', rank: 10 } },
      { type: 'take' },
      { type: 'pass' },
    ];
    for (const move of moves) expect(ClientMoveSchema.safeParse(move).success).toBe(true);
  });

  it('rejects a client-supplied playerId (identity comes from the session only)', () => {
    expect(ClientMoveSchema.safeParse({ type: 'take', playerId: 'someone-else' }).success).toBe(false);
  });

  it('rejects cards outside the 36-card deck and malformed payloads', () => {
    const bad = [
      { type: 'attack', card: { suit: 'S', rank: 5 } },
      { type: 'attack', card: { suit: 'X', rank: 6 } },
      { type: 'attack', card: { suit: 'S', rank: '6' } },
      { type: 'attack' },
      { type: 'defend', attackIndex: 6, card: { suit: 'S', rank: 7 } },
      { type: 'defend', attackIndex: -1, card: { suit: 'S', rank: 7 } },
      { type: 'defend', attackIndex: 1.5, card: { suit: 'S', rank: 7 } },
      { type: 'cheat' },
      null,
      'take',
    ];
    for (const move of bad) expect(ClientMoveSchema.safeParse(move).success).toBe(false);
  });
});

describe('event payload schemas', () => {
  it('validates game:move payloads', () => {
    expect(MakeMovePayloadSchema.safeParse({ roomId: 'abcd1234', move: { type: 'pass' } }).success).toBe(true);
    expect(MakeMovePayloadSchema.safeParse({ roomId: '../etc', move: { type: 'pass' } }).success).toBe(false);
    expect(MakeMovePayloadSchema.safeParse({ roomId: 'abcd1234', move: { type: 'pass' }, extra: 1 }).success).toBe(false);
  });

  it('limits room size to 2-6 players and trims nicknames', () => {
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'Ivan', maxPlayers: 7 }).success).toBe(false);
    expect(CreateRoomPayloadSchema.safeParse({ nickname: '   ', maxPlayers: 4 }).success).toBe(false);
    const parsed = CreateRoomPayloadSchema.parse({ nickname: '  Ivan ', maxPlayers: 4, config: { mode: 'perevodnoy' } });
    expect(parsed.nickname).toBe('Ivan');
  });

  it('validates partial game configs', () => {
    expect(GameConfigInputSchema.safeParse({}).success).toBe(true);
    expect(GameConfigInputSchema.safeParse({ mode: 'durak' }).success).toBe(false);
    expect(GameConfigInputSchema.safeParse({ boutMaxCards: 7 }).success).toBe(false);
  });

  it('requires a reasonably long session token', () => {
    expect(ResumeSessionPayloadSchema.safeParse({ sessionToken: 'short' }).success).toBe(false);
    expect(ResumeSessionPayloadSchema.safeParse({ sessionToken: 'x'.repeat(32) }).success).toBe(true);
  });

  it('has a schema for every client event', () => {
    for (const name of Object.values(ClientEvents)) expect(ClientEventSchemas[name]).toBeDefined();
  });
});

describe('cardId', () => {
  it('formats cards compactly', () => {
    expect(cardId({ suit: 'H', rank: 10 })).toBe('10H');
    expect(cardId({ suit: 'S', rank: 14 })).toBe('AS');
    expect(cardId({ suit: 'C', rank: 11 })).toBe('JC');
  });
});
