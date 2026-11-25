import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import { lineCommission, type CommissionPayoutsFacade } from '../../commission-payouts';
import type { TaxFacade } from '../../tax';
import type { OwnCommissionSource, OwnLineCommission } from '../application/ports/own-commission';

/**
 * {@link OwnCommissionSource} over `catalog`'s `offerTaxCategories`, `tax`'s `categoryRates` and
 * `commission-payouts`' `ownCommissionOn` (once per request, for the rate; every amount then goes
 * through the ledger's `lineCommission`), each called with the seller's context unchanged. A
 * refusal, a fault or a missing rate is null: the estimate shows no money.
 */
export class FacadeOwnCommission implements OwnCommissionSource {
  constructor(
    private readonly payouts: CommissionPayoutsFacade,
    private readonly catalog: CatalogFacade,
    private readonly tax: TaxFacade,
  ) {}

  async lineTaxRate(
    context: CallContext,
    offerId: Id<'Offer'>,
  ): Promise<number | 'no-category' | null> {
    try {
      const categories = await this.catalog.offerTaxCategories(context, [offerId]);
      if (!categories.ok) return null;
      // No published category: checkout would refuse the line, so no rate is guessed.
      const code = categories.value.get(offerId);
      if (code === undefined) return 'no-category';
      const rates = await this.tax.categoryRates(context, [code]);
      if (!rates.ok || rates.value.ratesBps.length !== 1) return null;
      return rates.value.ratesBps[0] ?? null;
    } catch {
      return null;
    }
  }

  async commissionsOn(
    context: CallContext,
    amounts: readonly bigint[],
    taxInclusive: boolean,
    taxRateBps: number,
  ): Promise<readonly OwnLineCommission[] | null> {
    const [first] = amounts;
    if (first === undefined) return [];
    try {
      const answer = await this.payouts.ownCommissionOn(context, {
        amount: first,
        taxInclusive,
        taxRateBps,
      });
      if (!answer.ok) return null;
      const { rateBps } = answer.value;
      return amounts.map((amount) => {
        const line = lineCommission({ amount, taxInclusive, taxBps: taxRateBps, rateBps });
        return { commission: line.commission, sellerReceives: line.sellerReceives };
      });
    } catch {
      return null;
    }
  }
}
