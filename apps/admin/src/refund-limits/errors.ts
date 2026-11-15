import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'conflict.retry': 'stale',
  'ordering.refund-limit-not-found': 'not-found',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `refund-limits.error`) for a failed write. */
export function refundLimitProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 403) return 'denied';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
