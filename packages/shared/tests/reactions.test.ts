import { describe, expect, it } from 'vitest';
import { ClientEventSchemas, ClientEvents, REACTION_IDS, ReactPayloadSchema } from '../src/index.js';

describe('room:react payload', () => {
  it('accepts every reaction id', () => {
    for (const reactionId of REACTION_IDS) {
      expect(ReactPayloadSchema.safeParse({ roomId: 'abcd1234', reactionId }).success).toBe(true);
    }
  });

  it('rejects unknown ids, free text, extra keys and a bad room id', () => {
    expect(ReactPayloadSchema.safeParse({ roomId: 'abcd1234', reactionId: 'hello there' }).success).toBe(false);
    expect(ReactPayloadSchema.safeParse({ roomId: 'abcd1234', reactionId: 'LAUGH' }).success).toBe(false);
    expect(ReactPayloadSchema.safeParse({ roomId: 'abcd1234', reactionId: 'laugh', text: 'hi' }).success).toBe(false);
    expect(ReactPayloadSchema.safeParse({ roomId: 'x', reactionId: 'laugh' }).success).toBe(false);
    expect(ReactPayloadSchema.safeParse({ roomId: 'abcd1234' }).success).toBe(false);
  });

  it('is in the server validation map', () => {
    expect(ClientEventSchemas[ClientEvents.React]).toBe(ReactPayloadSchema);
  });

  it('ids are unique ASCII', () => {
    expect(new Set(REACTION_IDS).size).toBe(REACTION_IDS.length);
    for (const id of REACTION_IDS) expect(id).toMatch(/^[a-zA-Z]+$/);
  });
});
