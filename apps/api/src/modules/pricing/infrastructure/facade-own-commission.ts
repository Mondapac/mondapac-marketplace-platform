import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { TaxFacade } from '../../tax';
import type { OwnCommissionSource, OwnLineCommission } from '../application/ports/own-commission';

/**
 * {@link OwnCommissionSource} over `catalog`'s `offerTaxCategories`, `tax`'s `categoryRates` and
 * `commission-payouts`' `ownCommissionOn`, each called with the seller's context unchanged. A
 * refusal, a fault, a missing category or a missing rate is null: the estimate shows no money.
 */
export class FacadeOwnCommission implements OwnCommissionSource {
  constructor(
    private readonly payouts: CommissionPayoutsFacade,
    private readonly catalog: CatalogFacade,
    private readonly tax: TaxFacade,
  ) {}

  async lineTaxRate(context: CallContext, offerId: Id<'Offer'>): Promise<number | null> {
    try {
      const categories = await this.catalog.offerTaxCategories(context, [offerId]);
      if (!categories.ok) return null;
      // No published category: checkout would refuse the line, so no rate is guessed.
      const code = categories.value.get(offerId);
      if (code === undefined) return null;
      const rates = await this.tax.categoryRates(context, [code]);
      if (!rates.ok || rates.value.ratesBps.length !== 1) return null;
      return rates.value.ratesBps[0] ?? null;
    } catch {
      return null;
    }
  }

  async commissionOn(
    context: CallContext,
    amount: bigint,
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<OwnLineCommission | null> {
    try {
      const answer = await this.payouts.ownCommissionOn(context, {
        amount,
        taxInclusive,
        taxRateBps,
      });
      if (!answer.ok) return null;
      return { commission: answer.value.commission, sellerReceives: answer.value.sellerReceives };
    } catch {
      return null;
    }
  }
}
