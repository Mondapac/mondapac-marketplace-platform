import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, type CatalogFacade } from '../../catalog';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { TaxFacade } from '../../tax';
import type { SellerCatalogue } from '../application/ports/seller-catalogue';
import type {
  LineTaxRate,
  OwnCommission,
  SellerCommission,
} from '../application/ports/seller-commission';

/**
 * {@link SellerCommission} over `commission-payouts`' `ownCommissionOn`, with the line's tax rate
 * from `catalog`'s `offerTaxCategories` and `tax`'s `categoryRates`, each called with the seller's
 * context unchanged. A refusal, a fault, a missing rate or a missing category is null: the preview
 * shows no money.
 */
export class FacadeSellerCommission implements SellerCommission {
  constructor(
    private readonly payouts: CommissionPayoutsFacade,
    private readonly catalog: CatalogFacade,
    private readonly tax: TaxFacade,
  ) {}

  async lineTaxRate(
    context: CallContext,
    offerId: Id<'Offer'> | null,
  ): Promise<LineTaxRate | null> {
    try {
      let code: string | null = null;
      if (offerId !== null) {
        const categories = await this.catalog.offerTaxCategories(context, [offerId]);
        if (!categories.ok) return null;
        const found = categories.value.get(offerId);
        // No published category: checkout would refuse the line, so no rate is guessed.
        if (found === undefined) return null;
        code = found;
      }
      const rates = await this.tax.categoryRates(context, [code]);
      if (!rates.ok) return null;
      const rateBps = rates.value.ratesBps[0];
      if (rates.value.ratesBps.length !== 1 || rateBps === undefined) return null;
      return { rateBps, estimated: offerId === null };
    } catch {
      return null;
    }
  }

  async commissionOn(
    context: CallContext,
    amount: bigint,
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<OwnCommission | null> {
    try {
      const answer = await this.payouts.ownCommissionOn(context, {
        amount,
        taxInclusive,
        taxRateBps,
      });
      if (!answer.ok) return null;
      const { rateBps, commissionBase, commission, sellerReceives } = answer.value;
      return { rateBps, commissionBase, commission, sellerReceives };
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
