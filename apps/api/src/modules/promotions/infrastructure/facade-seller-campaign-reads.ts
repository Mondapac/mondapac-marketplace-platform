import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, type CatalogFacade } from '../../catalog';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { SellerCatalogue } from '../application/ports/seller-catalogue';
import type { SellerCommission } from '../application/ports/seller-commission';

/**
 * {@link SellerCommission} over `commission-payouts`' `commissionRates`, called with the seller's
 * context unchanged. A refusal, a fault or a missing rate is null: the preview shows no money.
 */
export class FacadeSellerCommission implements SellerCommission {
  constructor(private readonly payouts: CommissionPayoutsFacade) {}

  async rateBps(context: CallContext, sellerId: Id<'Seller'>): Promise<number | null> {
    try {
      const answer = await this.payouts.commissionRates(context, [sellerId]);
      if (!answer.ok) return null;
      return answer.value.get(sellerId)?.rateBps ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * {@link SellerCatalogue} over `catalog`'s facade, called with the seller's context unchanged.
 * Anything unreadable is null (or false for an ownership question): fail closed.
 */
export class FacadeSellerCatalogue implements SellerCatalogue {
  constructor(private readonly catalog: CatalogFacade) {}

  async sellsProducts(
    context: CallContext,
    sellerId: Id<'Seller'>,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlySet<Id<'Product'>> | null> {
    const sold = new Set<Id<'Product'>>();
    try {
      for (let i = 0; i < productIds.length; i += MAX_FACADE_BATCH) {
        const answer = await this.catalog.productsForLinking(
          context,
          productIds.slice(i, i + MAX_FACADE_BATCH),
          sellerId,
        );
        if (!answer.ok) return null;
        for (const [productId, facts] of answer.value) {
          if (facts.onSale && facts.soldBySeller) sold.add(productId);
        }
      }
    } catch {
      return null;
    }
    return sold;
  }

  async ownsSellUnit(
    context: CallContext,
    sellerId: Id<'Seller'>,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<boolean> {
    try {
      const answer = await this.catalog.offerSellUnits(context, [offerId]);
      if (!answer.ok) return false;
      const offer = answer.value.get(offerId);
      return (
        offer !== undefined &&
        offer.sellerId === sellerId &&
        offer.status !== 'deleted' &&
        offer.sellUnits.some((unit) => unit.variantId === variantId)
      );
    } catch {
      return false;
    }
  }
}
