import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import {
  MAX_FACADE_BATCH,
  type CatalogBatchTooLarge,
  type CatalogValidationFailed,
} from '../../contracts/catalog.facade';

export type OfferSellUnitsFailure = CatalogValidationFailed | CatalogBatchTooLarge;

/**
 * The request check of `offerSellUnits` (catalog design 9.1, L7): an array of well-formed Offer
 * ids, at most 200, duplicates collapsed. A larger call is `batch.too-large`, a malformed one
 * `validation.failed`; both are refused whole, before any read.
 */
export function parseOfferIds(
  offerIds: readonly string[],
): Result<Set<Id<'Offer'>>, OfferSellUnitsFailure> {
  if (!Array.isArray(offerIds)) {
    return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'type' }] });
  }
  if (offerIds.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
  const ids = new Set<Id<'Offer'>>();
  for (const value of offerIds as readonly unknown[]) {
    const parsed = typeof value === 'string' ? parseId<'Offer'>(value) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'offerIds', code: 'format' }] });
    }
    ids.add(parsed.value);
  }
  return ok(ids);
}
