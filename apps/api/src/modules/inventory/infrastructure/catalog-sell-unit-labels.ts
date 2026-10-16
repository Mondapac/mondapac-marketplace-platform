import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, sellUnitKey, type CatalogFacade } from '../../catalog';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SellUnitLabel, SellUnitLabelsSource } from '../application/ports/sell-unit-labels';

/**
 * {@link SellUnitLabelsSource} over catalog's facade `sellUnitLabels`, in the Market's default
 * locale. The caller's `CallContext` goes through unchanged; larger requests are split to the
 * facade's batch limit. Any refusal is thrown.
 */
export class CatalogSellUnitLabels implements SellUnitLabelsSource {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly markets: MarketRegistry,
  ) {}

  async labelsOf(
    context: CallContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<ReadonlyMap<string, SellUnitLabel>> {
    const locale = this.markets.get(context.market.marketId).defaultLocale;
    const labels = new Map<string, SellUnitLabel>();
    for (let start = 0; start < keys.length; start += MAX_FACADE_BATCH) {
      const batch = keys.slice(start, start + MAX_FACADE_BATCH);
      const answer = await this.catalog.sellUnitLabels(context, batch, locale);
      if (!answer.ok) throw new Error(`catalog.sellUnitLabels: ${answer.error.code}`);
      for (const key of batch) {
        // Only what was asked for: an extra key in the answer is ignored.
        const label = answer.value.get(sellUnitKey(key));
        if (label !== undefined) {
          labels.set(`${key.offerId}:${key.variantId}`, {
            productName: label.productName,
            variantLabel: label.variantLabel,
          });
        }
      }
    }
    return labels;
  }
}
