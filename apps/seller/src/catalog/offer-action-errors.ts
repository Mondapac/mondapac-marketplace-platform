import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'offer.handling-missing': 'handling-missing',
  'offer.not-submittable': 'not-submittable',
  'offer.product-not-published': 'product-not-published',
  'offer.not-found': 'not-found',
  'offer.delete-via-product': 'delete-via-product',
  'claim-text.refused': 'claim-text',
  'type.not-allowed': 'type-not-allowed',
  'seller.not-eligible': 'not-eligible',
  'conflict.stale': 'stale',
  'request.throttled': 'throttled',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
};

/** The message key (under `catalog.offer-actions.error`) of a refused submit or delete. */
export function offerActionErrorOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return `catalog.offer-actions.error.${named}`;
  if (failure.status === 503 || failure.status === 0)
    return 'catalog.offer-actions.error.unavailable';
  return 'catalog.offer-actions.error.unknown';
}
