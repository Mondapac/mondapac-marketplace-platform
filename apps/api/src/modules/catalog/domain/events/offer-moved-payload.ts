import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

export type OfferMovedPayloadRefused = {
  readonly code: 'offer-moved.mapping-invalid';
  readonly reason: 'empty' | 'duplicate' | 'too-many';
};

/**
 * The one way to build the variant mapping of `catalog.offer-moved.v1` (catalog design 9.4): two
 * lists read pairwise, of equal length, at least one entry, no id repeated within either list,
 * and at most `maxVariantsPerProduct` entries. A mapping that breaks one is refused here, so no
 * such event is emitted; consumers (inventory V-1, pricing P-1) dead-letter one whole.
 */
export function buildOfferMovedMapping(
  pairs: readonly { readonly from: Id<'Variant'>; readonly to: Id<'Variant'> }[],
  maxVariantsPerProduct: number,
): Result<
  { readonly fromVariantIds: Id<'Variant'>[]; readonly toVariantIds: Id<'Variant'>[] },
  OfferMovedPayloadRefused
> {
  if (pairs.length === 0) return err({ code: 'offer-moved.mapping-invalid', reason: 'empty' });
  if (pairs.length > maxVariantsPerProduct) {
    return err({ code: 'offer-moved.mapping-invalid', reason: 'too-many' });
  }
  const fromVariantIds = pairs.map((pair) => pair.from);
  const toVariantIds = pairs.map((pair) => pair.to);
  if (
    new Set(fromVariantIds).size !== pairs.length ||
    new Set(toVariantIds).size !== pairs.length
  ) {
    return err({ code: 'offer-moved.mapping-invalid', reason: 'duplicate' });
  }
  return ok({ fromVariantIds, toVariantIds });
}
