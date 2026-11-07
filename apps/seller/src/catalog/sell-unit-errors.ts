// The message key (under `catalog.variants-table.sell-units.error`) of a refused
// `own-offer.set-sell-units` call.
const BY_CODE: Readonly<Record<string, string>> = {
  'offer.sku-taken': 'sku-taken',
  'offer.none-selling': 'none-selling',
  'validation.failed': 'invalid',
  'conflict.stale': 'stale',
  'offer.not-found': 'not-found',
  'access.denied': 'denied',
  'seller.not-eligible': 'not-eligible',
  'request.csrf': 'csrf',
};

export function sellUnitProblemOf(code: string): string {
  return BY_CODE[code] ?? 'unknown';
}
