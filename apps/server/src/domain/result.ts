import type { ErrorPayload, GameErrorCode, ServerErrorCode } from '@durak/shared';

export type ServiceError = ErrorPayload;

export type Result<T, E = ServiceError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function fail(
  code: ServerErrorCode | GameErrorCode,
  message: string,
): { readonly ok: false; readonly error: ServiceError } {
  return { ok: false, error: { code, message } };
}
