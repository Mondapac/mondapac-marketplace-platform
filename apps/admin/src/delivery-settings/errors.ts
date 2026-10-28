import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'shipping.delivery-settings-conflict': 'conflict',
  'shipping.seller-not-found': 'not-found',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `deliverySettings.error`) for a failed write. */
export function deliveryProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
