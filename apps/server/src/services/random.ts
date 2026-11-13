import { randomBytes, randomInt } from 'node:crypto';

/** 256-bit, URL-safe session token. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newPlayerId(): string {
  return `p_${randomBytes(9).toString('base64url')}`;
}

export function newSpectatorId(): string {
  return `s_${randomBytes(9).toString('base64url')}`;
}

/** 8 URL-safe characters; matches RoomIdSchema. */
export function newRoomId(): string {
  return randomBytes(6).toString('base64url');
}

export type SeedSource = () => number;

/** Uniform 32-bit seed for the engine's PRNG. */
export const cryptoSeedSource: SeedSource = () => randomInt(0, 2 ** 32);

/** Ids for games and restart votes (URL-safe, short). */
export function newShortId(): string {
  return randomBytes(6).toString('base64url');
}
