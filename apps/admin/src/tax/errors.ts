import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'tax.strategy-active': 'active',
  'tax.strategy-not-found': 'not-found',
  'tax.unavailable': 'unavailable',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `tax.error`) for a failed write. */
export function taxProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 403) return 'denied';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
