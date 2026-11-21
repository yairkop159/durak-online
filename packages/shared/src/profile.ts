import { z } from 'zod';
import { NicknameSchema } from './events.js';
import type { GameEndReason } from './events.js';
import type { GameMode } from './config.js';

// Phase 10: password-free device profiles, match history and ELO ratings.
// Served over HTTP under /api (request/response); every body and param is validated with these
// schemas. No email, no password, no personal data: a nickname, a random public id and a secret
// device key that only the device holds (the server stores its SHA-256).

export const RATING_START = 1000;
export const RATING_K = 32;
export const LEADERBOARD_SIZE = 20;
export const RECENT_GAMES_LIMIT = 20;
/** A transfer code is valid this long and works once. */
export const TRANSFER_CODE_TTL_MS = 10 * 60_000;
export const TRANSFER_CODE_LENGTH = 8;
/** Crockford base32: no I, L, O or U, so a code read aloud or retyped is unambiguous. */
export const TRANSFER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 random bytes, base64url. Public (shown in links and the leaderboard). */
export const ProfileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'Invalid profile id');
/** 32 random bytes, base64url. Secret: identifies the device holding the profile. */
export const DeviceKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid device key');

/**
 * Normalizes a typed transfer code: upper case, spaces and dashes dropped, and the look-alikes
 * O → 0, I/L → 1 (Crockford). Returns null when the result is not a well-formed code.
 */
export function normalizeTransferCode(raw: string): string | null {
  const code = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (code.length !== TRANSFER_CODE_LENGTH) return null;
  for (const ch of code) if (!TRANSFER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** "ABCD1234" → "ABCD-1234" for display. */
export function formatTransferCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const TransferCodeSchema = z
  .string()
  .max(32)
  .transform((raw, ctx) => {
    const code = normalizeTransferCode(raw);
    if (code === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid transfer code' });
      return z.NEVER;
    }
    return code;
  });

export const CreateProfileBodySchema = z.object({ nickname: NicknameSchema }).strict();
export const RenameProfileBodySchema = z.object({ nickname: NicknameSchema }).strict();
export const ClaimProfileBodySchema = z.object({ code: TransferCodeSchema }).strict();
export const ProfileIdParamsSchema = z.object({ id: ProfileIdSchema }).strict();

export type CreateProfileBody = z.input<typeof CreateProfileBodySchema>;
export type RenameProfileBody = z.input<typeof RenameProfileBodySchema>;
export type ClaimProfileBody = z.input<typeof ClaimProfileBodySchema>;

/** What a device keeps: returned by create and claim. */
export interface ProfileCredentials {
  readonly profileId: string;
  readonly deviceKey: string;
  readonly nickname: string;
}

/** GET /api/profile/me: the key is valid; who it belongs to. */
export interface MyProfile {
  readonly profileId: string;
  readonly nickname: string;
}

export interface TransferCodeResponse {
  readonly code: string;
  readonly expiresAt: number;
  /** Server clock when issued; remaining = expiresAt - serverTime (clock-skew free). */
  readonly serverTime: number;
}

/**
 * One player's outcome in a stored game:
 * - forfeit: left the game or their reconnection grace expired (a loss);
 * - durak: the last player holding cards (a loss);
 * - unfinished: the game was abandoned or restarted (not rated);
 * - draw: the game ended without a durak;
 * - teamLoss: team mode, the durak's partner (their team lost);
 * - win: everyone else.
 */
export const PLAYER_RESULTS = ['win', 'durak', 'draw', 'forfeit', 'unfinished', 'teamLoss'] as const;
export type PlayerResult = (typeof PLAYER_RESULTS)[number];

export interface RecentGamePlayer {
  readonly nickname: string;
  readonly isBot: boolean;
  /** Null for bots and humans without a profile. */
  readonly profileId: string | null;
  readonly result: PlayerResult;
}

export interface RecentGame {
  readonly gameId: string;
  readonly endedAt: number;
  readonly mode: GameMode;
  /** A 2v2 team game (absent in older responses = a classic game). */
  readonly teams?: boolean;
  readonly endReason: GameEndReason;
  readonly rated: boolean;
  readonly result: PlayerResult;
  /** Null when the game was not rated. */
  readonly ratingBefore: number | null;
  readonly ratingAfter: number | null;
  /** A bot played for this player at some point (AFK or leave takeover). */
  readonly botAssisted: boolean;
  /** The other seats, in seat order. */
  readonly others: readonly RecentGamePlayer[];
}

export interface PublicProfile {
  readonly profileId: string;
  readonly nickname: string;
  readonly rating: number;
  /** Stored games (every finished game with this profile, rated or not). */
  readonly games: number;
  readonly ratedGames: number;
  readonly wins: number;
  readonly duraks: number;
  readonly forfeits: number;
  /** Tournaments won (co-champions each count one). */
  readonly tournamentsWon: number;
  /** Leaderboard position (1-based), or null before the first rated game. */
  readonly rank: number | null;
  readonly recent: readonly RecentGame[];
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly profileId: string;
  readonly nickname: string;
  readonly rating: number;
  readonly ratedGames: number;
  readonly wins: number;
  readonly duraks: number;
}

export interface LeaderboardResponse {
  readonly entries: readonly LeaderboardEntry[];
}

export const API_ERROR_CODES = [
  'INVALID_PAYLOAD',
  /** Missing, malformed or revoked device key. */
  'UNAUTHORIZED',
  'NOT_FOUND',
  /** Unknown, expired or already used transfer code. */
  'INVALID_CODE',
  'RATE_LIMITED',
  /** Postgres is down or not configured: profiles and ratings are off, games still run. */
  'RATINGS_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: ApiErrorCode;
}
