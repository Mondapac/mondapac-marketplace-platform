import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'commission-payouts.seller-not-found': 'seller-not-found',
  'commission-payouts.seller-order-not-found': 'order-not-found',
  'commission-payouts.version-conflict': 'version-conflict',
  'commission-payouts.terms-not-set': 'terms-not-set',
  'commission-payouts.hold-not-found': 'hold-not-found',
  'commission-payouts.hold-already-released': 'hold-released',
  'validation.failed': 'validation',
  'request.throttled': 'throttled',
  'request.csrf': 'session',
  'access.denied': 'denied',
};

/** The message key (under `payouts.seller.error`) for a failed terms or hold call. */
export function sellerProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
