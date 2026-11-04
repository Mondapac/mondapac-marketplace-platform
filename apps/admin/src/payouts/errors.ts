import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'commission-payouts.payout.amount-changed': 'amount-changed',
  'commission-payouts.payout.not-awaiting-approval': 'not-awaiting',
  'commission-payouts.payout-not-found': 'not-found',
  'access.denied': 'denied',
  'validation.failed': 'unknown',
  'request.csrf': 'session',
  'request.throttled': 'throttled',
};

/** The message key (under `payouts.error`) for a failed approval. */
export function approveProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** Problems after which the payout on screen is out of date and the list must be read again. */
export const STALE_PROBLEMS: readonly string[] = ['amount-changed', 'not-awaiting', 'not-found'];
