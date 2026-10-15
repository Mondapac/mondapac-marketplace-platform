import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'commission-payouts.seller-not-found': 'not-found',
  'commission-payouts.rate-not-set': 'not-set',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `commission.error`) for a failed rate or ledger call. */
export function commissionProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
