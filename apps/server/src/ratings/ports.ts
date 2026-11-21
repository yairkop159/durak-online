import type { LeaderboardResponse, MyProfile, ProfileCredentials, PublicProfile, RatingEntry } from '@durak/shared';
import type { GameResultInput } from './gameResult.js';
import type { TournamentResultInput } from './tournamentResult.js';

/** Postgres is not configured or not reachable: profiles and ratings are off (games still run). */
export class RatingsUnavailableError extends Error {
  constructor(message = 'ratings unavailable') {
    super(message);
    this.name = 'RatingsUnavailableError';
  }
}

/**
 * Errors that mean "the database is not there" (down, unreachable, not configured) rather than a
 * bug: retried by the result queue, answered 503 by the API.
 */
export function isUnavailable(error: unknown): boolean {
  if (error instanceof RatingsUnavailableError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof name === 'string' && /Initialization|DriverAdapter/.test(name)) return true;
  if (typeof code === 'string' && /^(P1\d{3}|P2024|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|57P01)$/.test(code)) return true;
  return typeof message === 'string' && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|connect|timed out/i.test(message);
}

/** A short, value-free description of an error for logs (driver messages can carry query values). */
export function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return [typeof name === 'string' ? name : 'Error', typeof code === 'string' ? code : ''].filter(Boolean).join(' ');
}

/**
 * `recorded`: this call wrote the game (the transaction committed); `ratings` holds every rated
 * human's change, or null when the game is not rated. `duplicate`: it was already stored, nothing
 * was written (a retry or a startup re-submission).
 */
export type RecordOutcome =
  | { readonly kind: 'recorded'; readonly ratings: readonly RatingEntry[] | null }
  | { readonly kind: 'duplicate' };

/**
 * The match history (Phase 10). `recordGame` writes a finished game, its seats and every rating
 * change in ONE transaction, idempotent by gameId: recording the same game again changes nothing.
 */
export interface ResultStore {
  recordGame(input: GameResultInput): Promise<RecordOutcome>;
  /**
   * Writes a finished or early-ended tournament, its roster and the champions' `tournaments_won`
   * in ONE transaction, idempotent by tournamentId (a duplicate writes nothing).
   */
  recordTournament(input: TournamentResultInput): Promise<{ readonly kind: 'recorded' | 'duplicate' }>;
}

/** Read side: public profiles (rank + recent games) and the top-20 leaderboard. */
export interface HistoryStore {
  publicProfile(profileId: string): Promise<PublicProfile | null>;
  leaderboard(): Promise<LeaderboardResponse>;
}

export interface IssuedTransferCode {
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * Device profiles (Phase 10). Every method may throw RatingsUnavailableError (or a driver error)
 * when Postgres is down; callers on the game path must never let that reach a game.
 */
export interface ProfileStore {
  create(nickname: string): Promise<ProfileCredentials>;
  /** The profile a device key belongs to, or null (unknown or revoked key). */
  resolveKey(deviceKey: string): Promise<MyProfile | null>;
  rename(deviceKey: string, nickname: string): Promise<MyProfile | null>;
  /** A fresh one-time code (replaces any open one), or null for an unknown key. */
  issueTransferCode(deviceKey: string, now: number, ttlMs: number): Promise<IssuedTransferCode | null>;
  /**
   * Moves the profile to the claiming device: a new device key is issued and the old one stops
   * working. Null for an unknown, expired or used code.
   */
  claim(code: string, now: number): Promise<ProfileCredentials | null>;
}
