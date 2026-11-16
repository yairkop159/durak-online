import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type LeaderboardResponse,
  type MyProfile,
  type ProfileCredentials,
  type PublicProfile,
  type TransferCodeResponse,
} from '@durak/shared';
import { serverUrl } from '../net/transport';

/** Why a call failed: the server's code, or NETWORK (offline, timeout, not JSON). */
export type ProfileApiError = ApiErrorCode | 'NETWORK';
export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProfileApiError };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8_000;
const isApiErrorCode = (v: unknown): v is ApiErrorCode => typeof v === 'string' && (API_ERROR_CODES as readonly string[]).includes(v);

/**
 * The profile HTTP API (/api on the game server). Never throws: every failure is a result, so a
 * missing or broken ratings service can never break the app (games do not depend on it).
 */
export class ProfileApi {
  constructor(
    private readonly base: string = serverUrl(),
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async call<T>(method: string, path: string, options: { key?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/api${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data: unknown = await res.json().catch(() => null);
      if (res.ok && data !== null) return { ok: true, value: data as T };
      const code = (data as { error?: unknown } | null)?.error;
      return { ok: false, error: isApiErrorCode(code) ? code : 'NETWORK' };
    } catch {
      return { ok: false, error: 'NETWORK' };
    }
  }

  create(nickname: string) {
    return this.call<ProfileCredentials>('POST', '/profile', { body: { nickname } });
  }

  me(deviceKey: string) {
    return this.call<MyProfile>('GET', '/profile/me', { key: deviceKey });
  }

  rename(deviceKey: string, nickname: string) {
    return this.call<MyProfile>('PATCH', '/profile/me', { key: deviceKey, body: { nickname } });
  }

  transferCode(deviceKey: string) {
    return this.call<TransferCodeResponse>('POST', '/profile/transfer-code', { key: deviceKey, body: {} });
  }

  claim(code: string) {
    return this.call<ProfileCredentials>('POST', '/profile/claim', { body: { code } });
  }

  publicProfile(profileId: string) {
    return this.call<PublicProfile>('GET', `/profile/${encodeURIComponent(profileId)}`);
  }

  leaderboard() {
    return this.call<LeaderboardResponse>('GET', '/leaderboard');
  }
}
