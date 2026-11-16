import { describe, expect, it } from 'vitest';
import {
  ClaimProfileBodySchema,
  CreateProfileBodySchema,
  CreateRoomPayloadSchema,
  DeviceKeySchema,
  JoinRoomPayloadSchema,
  ProfileIdSchema,
  TRANSFER_CODE_ALPHABET,
  formatTransferCode,
  normalizeTransferCode,
} from '../src/index.js';

const KEY = 'A'.repeat(43);

describe('profile ids and device keys', () => {
  it('accepts base64url of the right length only', () => {
    expect(ProfileIdSchema.safeParse('abcdefghij_-0123456789').success).toBe(true);
    expect(ProfileIdSchema.safeParse('short').success).toBe(false);
    expect(ProfileIdSchema.safeParse('abcdefghij+/0123456789').success).toBe(false);
    expect(DeviceKeySchema.safeParse(KEY).success).toBe(true);
    expect(DeviceKeySchema.safeParse(KEY + 'A').success).toBe(false);
  });

  it('room:create / room:join take an optional device key', () => {
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'a', maxPlayers: 2 }).success).toBe(true);
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'a', maxPlayers: 2, deviceKey: KEY }).success).toBe(true);
    expect(CreateRoomPayloadSchema.safeParse({ nickname: 'a', maxPlayers: 2, deviceKey: 'x' }).success).toBe(false);
    expect(JoinRoomPayloadSchema.safeParse({ roomId: 'abcd1234', nickname: 'a', deviceKey: KEY }).success).toBe(true);
    expect(JoinRoomPayloadSchema.safeParse({ roomId: 'abcd1234', nickname: 'a', deviceKey: 5 }).success).toBe(false);
  });

  it('profile bodies are strict and trim the nickname', () => {
    expect(CreateProfileBodySchema.parse({ nickname: '  Dana ' })).toEqual({ nickname: 'Dana' });
    expect(CreateProfileBodySchema.safeParse({ nickname: '' }).success).toBe(false);
    expect(CreateProfileBodySchema.safeParse({ nickname: 'a', email: 'x@y' }).success).toBe(false);
  });
});

describe('transfer codes', () => {
  it('alphabet is 32 unambiguous symbols', () => {
    expect(new Set(TRANSFER_CODE_ALPHABET).size).toBe(32);
    for (const ch of 'ILOU') expect(TRANSFER_CODE_ALPHABET).not.toContain(ch);
  });

  it('normalizes case, separators and look-alikes', () => {
    expect(normalizeTransferCode('abcd-1234')).toBe('ABCD1234');
    expect(normalizeTransferCode(' ab cd 12 34 ')).toBe('ABCD1234');
    expect(normalizeTransferCode('OOII-LLAA')).toBe('001111AA');
    expect(normalizeTransferCode('ABCD123')).toBeNull();
    expect(normalizeTransferCode('ABCD12345')).toBeNull();
    expect(normalizeTransferCode('ABCD-12U4')).toBeNull();
    expect(normalizeTransferCode('ABCD-12!4')).toBeNull();
  });

  it('the claim body carries the normalized code', () => {
    expect(ClaimProfileBodySchema.parse({ code: 'abcd-1234' })).toEqual({ code: 'ABCD1234' });
    expect(ClaimProfileBodySchema.safeParse({ code: 'nope' }).success).toBe(false);
    expect(formatTransferCode('ABCD1234')).toBe('ABCD-1234');
  });
});
