import {
  ClaimProfileBodySchema,
  CreateProfileBodySchema,
  DeviceKeySchema,
  RenameProfileBodySchema,
  TRANSFER_CODE_TTL_MS,
  type ApiErrorBody,
  type ApiErrorCode,
  type TransferCodeResponse,
} from '@durak/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { RatingsUnavailableError, type ProfileStore } from '../ratings/ports.js';
import { SlidingWindowLimiter } from '../transport/rateLimit.js';

// Phase 10: the profile HTTP API under /api (request/response; Socket.io here has no acks).
// - Every body and param goes through its shared Zod schema first; errors are { error: code }.
// - The device key travels only in `Authorization: Bearer <key>` and is never logged.
// - Postgres down → 503 RATINGS_UNAVAILABLE; games are never affected.
// - Per-IP limits use the server's one client-address rule (trusted proxies, see clientAddress.ts).

export interface ApiLimits {
  /** Any /api request, per client IP per rolling minute. */
  readonly requestsPerMinute: number;
  /** POST /api/profile, per client IP per rolling hour. */
  readonly profileCreatesPerHour: number;
  /** POST /api/profile/claim, per client IP per rolling 10 minutes (transfer codes are 40 bits). */
  readonly claimsPerTenMinutes: number;
}

export const DEFAULT_API_LIMITS: ApiLimits = { requestsPerMinute: 120, profileCreatesPerHour: 20, claimsPerTenMinutes: 10 };
export const UNLIMITED_API: ApiLimits = {
  requestsPerMinute: Number.POSITIVE_INFINITY,
  profileCreatesPerHour: Number.POSITIVE_INFINITY,
  claimsPerTenMinutes: Number.POSITIVE_INFINITY,
};

export interface ApiLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export interface ApiDeps {
  readonly profiles: ProfileStore;
  readonly clientIpOf: (peer: string, headers: Readonly<Record<string, string | string[] | undefined>>) => string;
  readonly now: () => number;
  readonly corsOrigins: readonly string[];
  readonly limits: ApiLimits;
  readonly log: ApiLogger;
}

const MINUTE = 60_000;
const API_BODY_LIMIT = 4 * 1024;

const STATUS: Record<ApiErrorCode, number> = {
  INVALID_PAYLOAD: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INVALID_CODE: 400,
  RATE_LIMITED: 429,
  RATINGS_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}

function sendError(reply: FastifyReply, code: ApiErrorCode): FastifyReply {
  const body: ApiErrorBody = { error: code };
  return reply.code(STATUS[code]).header('cache-control', 'no-store').send(body);
}

/** Errors from the store that mean "the database is not there" rather than a bug. */
export function isUnavailable(error: unknown): boolean {
  if (error instanceof RatingsUnavailableError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof name === 'string' && /Initialization|DriverAdapter/.test(name)) return true;
  if (typeof code === 'string' && /^(P1\d{3}|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|57P01)$/.test(code)) return true;
  return typeof message === 'string' && /ECONNREFUSED|ETIMEDOUT|Connection terminated|connect/.test(message);
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new ApiError('INVALID_PAYLOAD');
  return parsed.data;
}

function bearerKey(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
  const key = match?.[1];
  if (!key || !DeviceKeySchema.safeParse(key).success) throw new ApiError('UNAUTHORIZED');
  return key;
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { profiles, now, limits, log } = deps;
  const requests = new SlidingWindowLimiter(limits.requestsPerMinute, MINUTE, now);
  const creates = new SlidingWindowLimiter(limits.profileCreatesPerHour, 60 * MINUTE, now);
  const claims = new SlidingWindowLimiter(limits.claimsPerTenMinutes, 10 * MINUTE, now);
  const corsOrigins = new Set(deps.corsOrigins);
  const ipOf = (request: FastifyRequest) => deps.clientIpOf(request.socket.remoteAddress ?? '', request.headers);

  const charge = (limiter: SlidingWindowLimiter, ip: string) => {
    if (!limiter.canHit(ip)) throw new ApiError('RATE_LIMITED');
    limiter.record(ip);
  };

  void app.register(
    async (api) => {
      // CORS for the dev client (Vite on another port) and any listed origin; same-origin needs none.
      api.addHook('onRequest', async (request, reply) => {
        const origin = request.headers.origin;
        if (typeof origin === 'string' && corsOrigins.has(origin)) {
          reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
        }
        if (request.method === 'OPTIONS') {
          return reply
            .code(204)
            .header('access-control-allow-methods', 'GET, POST, PATCH')
            .header('access-control-allow-headers', 'authorization, content-type')
            .header('access-control-max-age', '600')
            .send();
        }
        const ip = ipOf(request);
        if (!requests.canHit(ip)) return sendError(reply, 'RATE_LIMITED');
        requests.record(ip);
        reply.header('cache-control', 'no-store');
        return undefined;
      });

      api.setErrorHandler((error: unknown, request, reply) => {
        if (error instanceof ApiError) return sendError(reply, error.code);
        if (isUnavailable(error)) {
          log.warn({ route: request.routeOptions.url, err: errorName(error) }, 'api: ratings unavailable');
          return sendError(reply, 'RATINGS_UNAVAILABLE');
        }
        const status = (error as { statusCode?: unknown }).statusCode;
        if (typeof status === 'number' && status >= 400 && status < 500) return sendError(reply, 'INVALID_PAYLOAD');
        // Never the message: driver errors can carry query values.
        log.warn({ route: request.routeOptions.url, err: errorName(error) }, 'api: request failed');
        return sendError(reply, 'INTERNAL');
      });
      api.setNotFoundHandler((_request, reply) => sendError(reply, 'NOT_FOUND'));
      api.options('/*', async (_request, reply) => reply.code(204).send());

      api.post('/profile', { bodyLimit: API_BODY_LIMIT }, async (request) => {
        const { nickname } = parse(CreateProfileBodySchema, request.body);
        charge(creates, ipOf(request));
        return profiles.create(nickname);
      });

      api.get('/profile/me', async (request) => {
        const me = await profiles.resolveKey(bearerKey(request));
        if (!me) throw new ApiError('UNAUTHORIZED');
        return me;
      });

      api.patch('/profile/me', { bodyLimit: API_BODY_LIMIT }, async (request) => {
        const key = bearerKey(request);
        const { nickname } = parse(RenameProfileBodySchema, request.body);
        const me = await profiles.rename(key, nickname);
        if (!me) throw new ApiError('UNAUTHORIZED');
        return me;
      });

      api.post('/profile/transfer-code', { bodyLimit: API_BODY_LIMIT }, async (request) => {
        const key = bearerKey(request);
        const at = now();
        const issued = await profiles.issueTransferCode(key, at, TRANSFER_CODE_TTL_MS);
        if (!issued) throw new ApiError('UNAUTHORIZED');
        const body: TransferCodeResponse = { code: issued.code, expiresAt: issued.expiresAt, serverTime: at };
        return body;
      });

      api.post('/profile/claim', { bodyLimit: API_BODY_LIMIT }, async (request) => {
        // Charged before parsing too: every guess counts, well-formed or not.
        charge(claims, ipOf(request));
        const { code } = parse(ClaimProfileBodySchema, request.body);
        const claimed = await profiles.claim(code, now());
        if (!claimed) throw new ApiError('INVALID_CODE');
        log.info({ profileId: claimed.profileId }, 'profile moved to another device');
        return claimed;
      });
    },
    { prefix: '/api' },
  );
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return [typeof name === 'string' ? name : 'Error', typeof code === 'string' ? code : ''].filter(Boolean).join(' ');
}
