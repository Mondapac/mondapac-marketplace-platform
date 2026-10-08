import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import {
  MAX_FACADE_BATCH,
  type CatalogBatchTooLarge,
  type CatalogValidationFailed,
  type OfferSellUnitsMap,
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

/**
 * Fail-closed stand-in for `offerSellUnits` (ADR-0031 decision 6; catalog slice 7 builds the
 * real one). Every Offer is **absent**: no Offer exists before slice 7, so that is the true
 * answer today, and every consumer treats absent as not sellable (pricing P-1, cart K-1;
 * `inventory` does not call this method before the real binding). It reads nothing and calls no
 * other module. Slice 7 replaces it and deletes this comment; until then nothing here can
 * return an entry, and no flag, config switch or default branch may be added.
 */
export function absentForEveryKey(): OfferSellUnitsMap {
  return new Map();
}
