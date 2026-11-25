import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type { CommissionPayoutsFacade } from '../../commission-payouts';
import type { TaxFacade } from '../../tax';
import { FacadeOwnCommission } from './facade-own-commission';

// The own-commission adapter: the Offer's published tax category, its rate and the seller's own
// commission, each read with the caller's context unchanged; anything unreadable is null.

const context = { correlationId: 'c-1' } as unknown as CallContext;
const OFFER = '01990000-0000-7000-8000-00000000c001' as Id<'Offer'>;

function adapter(
  opts: {
    category?: string | null;
    catalogFails?: boolean;
    rates?: readonly number[] | null;
    commission?: 'ok' | 'refused' | 'throws';
  } = {},
) {
  const seen: unknown[] = [];
  const catalog = {
    offerTaxCategories: (ctx: CallContext, ids: readonly Id<'Offer'>[]) => {
      seen.push(['catalog', ctx, ids]);
      if (opts.catalogFails) return Promise.resolve(err({ code: 'access.denied' }));
      const map = new Map<Id<'Offer'>, string>();
      if (opts.category !== null) map.set(OFFER, opts.category ?? 'gst-free-food');
      return Promise.resolve(ok(map));
    },
  } as unknown as CatalogFacade;
  const tax = {
    categoryRates: (ctx: CallContext, codes: readonly (string | null)[]) => {
      seen.push(['tax', ctx, codes]);
      if (opts.rates === null) return Promise.resolve(err({ code: 'tax.unavailable' }));
      return Promise.resolve(ok({ ratesBps: opts.rates ?? [0] }));
    },
  } as unknown as TaxFacade;
  const payouts = {
    ownCommissionOn: (ctx: CallContext, request: unknown) => {
      seen.push(['payouts', ctx, request]);
      if (opts.commission === 'throws') return Promise.reject(new Error('down'));
      if (opts.commission === 'refused') return Promise.resolve(err({ code: 'access.denied' }));
      return Promise.resolve(
        ok({
          rateBps: 1500,
          source: 'seller',
          taxRateBps: 0,
          commissionBase: 1590n,
          commission: 239n,
          sellerReceives: 1351n,
        }),
      );
    },
  } as unknown as CommissionPayoutsFacade;
  return { source: new FacadeOwnCommission(payouts, catalog, tax), seen };
}

describe('FacadeOwnCommission', () => {
  it("reads the Offer's category rate with the caller's context", async () => {
    const { source, seen } = adapter({ rates: [1000] });
    expect(await source.lineTaxRate(context, OFFER)).toBe(1000);
    expect(seen).toEqual([
      ['catalog', context, [OFFER]],
      ['tax', context, ['gst-free-food']],
    ]);
  });

  it('answers null for no published category, a refusal or an odd rate list', async () => {
    expect(await adapter({ category: null }).source.lineTaxRate(context, OFFER)).toBeNull();
    expect(await adapter({ catalogFails: true }).source.lineTaxRate(context, OFFER)).toBeNull();
    expect(await adapter({ rates: null }).source.lineTaxRate(context, OFFER)).toBeNull();
    expect(await adapter({ rates: [] }).source.lineTaxRate(context, OFFER)).toBeNull();
    expect(await adapter({ rates: [0, 1000] }).source.lineTaxRate(context, OFFER)).toBeNull();
  });

  it('passes the commission and what the seller receives through, and nothing else', async () => {
    const { source, seen } = adapter();
    expect(await source.commissionOn(context, 1590n, true, 0)).toEqual({
      commission: 239n,
      sellerReceives: 1351n,
    });
    expect(seen).toEqual([
      ['payouts', context, { amount: 1590n, taxInclusive: true, taxRateBps: 0 }],
    ]);
  });

  it('answers null when the commission is refused or the call throws', async () => {
    const refused = adapter({ commission: 'refused' }).source;
    expect(await refused.commissionOn(context, 100n, true, 0)).toBeNull();
    const throws = adapter({ commission: 'throws' }).source;
    expect(await throws.commissionOn(context, 100n, true, 0)).toBeNull();
  });
});
