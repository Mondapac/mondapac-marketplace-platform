import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, type CatalogFacade } from '../../catalog';
import type { OrderTaxCategories } from '../application/ports/order-tax-categories';

/**
 * {@link OrderTaxCategories} over catalog's `offerTaxCategories`. Larger requests are split to
 * the facade's batch limit; any refusal is thrown. Only what was asked for is returned.
 */
export class FacadeOrderTaxCategories implements OrderTaxCategories {
  constructor(private readonly catalog: CatalogFacade) {}

  async categoriesOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, string>> {
    const requested = [...new Set(offerIds)];
    const result = new Map<Id<'Offer'>, string>();
    for (let start = 0; start < requested.length; start += MAX_FACADE_BATCH) {
      const batch = requested.slice(start, start + MAX_FACADE_BATCH);
      const answer = await this.catalog.offerTaxCategories(context, batch);
      if (!answer.ok) throw new Error(`catalog.offerTaxCategories: ${answer.error.code}`);
      for (const offerId of batch) {
        const code = answer.value.get(offerId);
        if (code !== undefined) result.set(offerId, code);
      }
    }
    return result;
  }
}
