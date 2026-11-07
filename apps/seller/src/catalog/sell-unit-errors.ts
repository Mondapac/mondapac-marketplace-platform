import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'offer.sku-taken': 'sku-taken',
  'offer.none-selling': 'none-selling',
  'offer.not-found': 'not-found',
  'conflict.stale': 'stale',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'seller.not-eligible': 'not-eligible',
};

/** The message key (under `catalog.variants-table.units.error`) for a failed sell-units write. */
export function unitProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.code === 'validation.failed') return 'invalid';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** The variant a refused field names (`units.<variantId>[.field]`), when the path has one. */
export function variantOfPath(path: string, variantIds: readonly string[]): string | null {
  const [head, id] = path.split('.');
  return head === 'units' && id !== undefined && variantIds.includes(id) ? id : null;
}
