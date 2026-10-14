import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'customer.not-found': 'not-found',
  'account.unknown': 'not-found',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'account.already-disabled': 'changed',
  'account.already-active': 'changed',
  'conflict.stale': 'changed',
  'conflict.retry': 'changed',
};

/** The message key (under `customers.error`) for a failed lookup or status change. */
export function customerProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
