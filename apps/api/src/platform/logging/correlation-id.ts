import { randomUUID } from 'node:crypto';

/** Header that carries the correlation id on requests and responses. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

// Accept only short, log-safe ids from callers; anything else is replaced, so a client
// cannot inject arbitrary text into log lines.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Returns the caller's correlation id when it is well formed, otherwise a new one. */
export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate !== undefined && SAFE_ID.test(candidate) ? candidate : randomUUID();
}
