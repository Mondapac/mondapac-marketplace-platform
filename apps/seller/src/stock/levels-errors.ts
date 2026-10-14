import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'conflict.stale': 'stale',
  'inventory.stock.below-held': 'below-held',
  'inventory.not-ready': 'not-ready',
  'inventory.not-found': 'not-found',
  'inventory.source.not-found': 'not-found',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'seller.not-eligible': 'not-eligible',
};

/** The message key (under `stock.levels.error`) for a failed stock write. */
export function levelsProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
