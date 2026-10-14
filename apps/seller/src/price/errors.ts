import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'conflict.stale': 'stale',
  'pricing.series-retired': 'retired',
  'pricing.offer-not-found': 'not-found',
  'pricing.amount-out-of-range': 'out-of-range',
  'pricing.special-price.not-found': 'special-not-found',
  'pricing.no-regular-price': 'no-regular',
  'pricing.special-not-below-regular': 'not-below',
  'pricing.special-window.invalid': 'window',
  'pricing.special-window.start-in-past': 'past',
  'pricing.regular-not-above-special': 'regular-not-above',
  'pricing.currency-mismatch': 'invalid',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'access.seller-not-approved': 'not-eligible',
  'seller.not-eligible': 'not-eligible',
};

/** The message key (under `price.error`) for a failed price write. */
export function priceProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
