import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CatalogFacade } from '../../catalog';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { TaxFacade } from '../../tax';
import { FacadeSellerCommission } from './facade-seller-campaign-reads';

// The binding of promotions' seller-commission port to the catalog, tax and commission-payouts
// facades, on both Market fixtures: the caller's context passes unchanged, the tax rate is the
// Offer's published category rate (or the no-category rate without an Offer), and every refusal,
// missing value or fault is null, which the preview reads as fail closed.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe.each(['AU', 'ZZ'] as const)('promotions seller commission reads in market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const offerId = id<'Offer'>(2);
  const category = code === 'AU' ? 'gst_free' : 'zz_reduced';

  const over = (
    offerTaxCategories: CatalogFacade['offerTaxCategories'],
    categoryRates: TaxFacade['categoryRates'],
    ownCommissionOn: CommissionPayoutsFacade['ownCommissionOn'] = () =>
      Promise.reject(new Error('not used')),
  ) =>
    new FacadeSellerCommission(
      { ownCommissionOn } as CommissionPayoutsFacade,
      { offerTaxCategories } as CatalogFacade,
      { categoryRates } as TaxFacade,
    );
  const categories = (value: ReadonlyMap<Id<'Offer'>, string>) => () => Promise.resolve(ok(value));
  const rates =
    (ratesBps: number[], calls: unknown[] = []): TaxFacade['categoryRates'] =>
    (ctx, codes) => {
      calls.push([ctx, codes]);
      return Promise.resolve(ok({ ratesBps }));
    };

  it("answers the Offer's own category rate, asking tax for that code with the caller context", async () => {
    const asked: unknown[] = [];
    const catalogCalls: unknown[] = [];
    const reads = over(
      (ctx, ids) => {
        catalogCalls.push([ctx, ids]);
        return Promise.resolve(ok(new Map([[offerId, category]])));
      },
      rates([0], asked),
    );
    expect(await reads.lineTaxRate(context, offerId)).toEqual({ rateBps: 0, estimated: false });
    expect(catalogCalls).toEqual([[context, [offerId]]]);
    expect(asked).toEqual([[context, [category]]]);
  });

  it('without an Offer asks for the no-category rate and marks it an estimate', async () => {
    const asked: unknown[] = [];
    const reads = over(() => Promise.reject(new Error('catalog not asked')), rates([1000], asked));
    expect(await reads.lineTaxRate(context, null)).toEqual({ rateBps: 1000, estimated: true });
    expect(asked).toEqual([[context, [null]]]);
  });

  it('is null for a refused catalogue, a missing category, a tax refusal, a wrong answer and a fault', async () => {
    const found = categories(new Map([[offerId, category]]));
    const cases: FacadeSellerCommission[] = [
      over(() => Promise.resolve(err({ code: 'access.denied' as const })), rates([0])),
      over(categories(new Map()), rates([0])),
      over(found, () => Promise.resolve(err({ code: 'tax.unavailable' as const }))),
      over(found, rates([])),
      over(found, rates([0, 1000])),
      over(() => Promise.reject(new Error('down')), rates([0])),
      over(found, () => Promise.reject(new Error('down'))),
    ];
    for (const reads of cases) expect(await reads.lineTaxRate(context, offerId)).toBeNull();
  });

  it('passes the tax rate to ownCommissionOn and answers its numbers, or null on a refusal', async () => {
    const calls: unknown[] = [];
    const reads = over(categories(new Map()), rates([0]), (ctx, request) => {
      calls.push([ctx, request]);
      return Promise.resolve(
        ok({
          rateBps: 1500,
          source: 'market' as const,
          taxRateBps: 0,
          commissionBase: 1590n,
          commission: 239n,
          sellerReceives: 1351n,
        }),
      );
    });
    expect(await reads.commissionOn(context, 1590n, true, 0)).toEqual({
      rateBps: 1500,
      commissionBase: 1590n,
      commission: 239n,
      sellerReceives: 1351n,
    });
    expect(calls).toEqual([[context, { amount: 1590n, taxInclusive: true, taxRateBps: 0 }]]);
    const refused = over(categories(new Map()), rates([0]), () =>
      Promise.resolve(err({ code: 'access.denied' as const })),
    );
    expect(await refused.commissionOn(context, 1n, true, 0)).toBeNull();
  });
});
