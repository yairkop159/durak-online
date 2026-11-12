import { ClientEventSchemas, type ClientEventName } from '@durak/shared';
import type { z } from 'zod';
import { fail, ok, type Result } from '../domain/result.js';

export type PayloadOf<E extends ClientEventName> = z.infer<(typeof ClientEventSchemas)[E]>;

/** Parses an incoming event payload with its shared Zod schema. Never throws. */
export function parsePayload<E extends ClientEventName>(event: E, raw: unknown): Result<PayloadOf<E>> {
  const schema: z.ZodTypeAny = ClientEventSchemas[event];
  const parsed = schema.safeParse(raw);
  if (parsed.success) return ok(parsed.data as PayloadOf<E>);
  const summary = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return fail('INVALID_PAYLOAD', `Invalid ${event} payload: ${summary}`);
}
