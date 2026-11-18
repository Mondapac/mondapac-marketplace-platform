import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, type CatalogFacade } from '../../catalog';
import type { OrderProducts } from '../application/ports/order-products';

/**
 * {@link OrderProducts} over catalog's `offerSellUnits`. Larger requests are split to the
 * facade's batch limit; any refusal is thrown. Only what was asked for is returned.
 */
export class FacadeOrderProducts implements OrderProducts {
  constructor(private readonly catalog: CatalogFacade) {}

  async productsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, Id<'Product'>>> {
    const requested = [...new Set(offerIds)];
    const result = new Map<Id<'Offer'>, Id<'Product'>>();
    for (let start = 0; start < requested.length; start += MAX_FACADE_BATCH) {
      const batch = requested.slice(start, start + MAX_FACADE_BATCH);
      const answer = await this.catalog.offerSellUnits(context, batch);
      if (!answer.ok) throw new Error(`catalog.offerSellUnits: ${answer.error.code}`);
      for (const offerId of batch) {
        const units = answer.value.get(offerId);
        if (units !== undefined) result.set(offerId, units.productId);
      }
    }
    return result;
  }
}
