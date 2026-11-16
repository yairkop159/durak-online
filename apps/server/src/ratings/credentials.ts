import { createHash, randomBytes, randomInt } from 'node:crypto';
import { TRANSFER_CODE_ALPHABET, TRANSFER_CODE_LENGTH } from '@durak/shared';

/** 16 random bytes, base64url (22 chars). Public. */
export function newProfileId(): string {
  return randomBytes(16).toString('base64url');
}

/** 32 random bytes, base64url (43 chars). Secret: only its hash is stored. */
export function newDeviceKey(): string {
  return randomBytes(32).toString('base64url');
}

/** 8 symbols of Crockford base32 (40 bits), uniformly random. */
export function newTransferCode(): string {
  let code = '';
  for (let i = 0; i < TRANSFER_CODE_LENGTH; i++) code += TRANSFER_CODE_ALPHABET[randomInt(TRANSFER_CODE_ALPHABET.length)];
  return code;
}

/**
 * SHA-256, hex. Device keys and transfer codes are random (256 / 40 bits) and short-lived or
 * rate-limited, so a fast unsalted hash is enough: the point is that a database leak does not
 * hand out working keys.
 */
export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
