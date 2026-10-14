import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'offer.not-pending-review': 'gone',
  'offer.not-found': 'gone',
  'offer.product-not-published': 'product-not-published',
  'seller.not-eligible': 'seller-not-eligible',
  'type.not-allowed': 'seller-not-eligible',
  'claim-text.refused': 'claim-text',
  'conflict.stale': 'stale',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface ReviewProblem {
  /** Full message key. */
  readonly key: string;
  /** True when the Offer is no longer waiting, so its card leaves the queue. */
  readonly gone: boolean;
}

export function reviewProblemOf(failure: ApiFailure): ReviewProblem {
  const named = BY_CODE[failure.code];
  const key =
    named ??
    (failure.code === 'validation.failed'
      ? 'invalid'
      : failure.status === 503 || failure.status === 0
        ? 'unavailable'
        : 'unknown');
  return { key: `catalog.review.error.${key}`, gone: key === 'gone' };
}
