import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, Money } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { CatalogFacade } from '../../catalog';
import type { InventoryFacade } from '../../inventory';
import type { PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import { FacadeProductDetailSources } from './facade-product-detail-sources';

// The product page's adapter over the four facades (Hassan L1): only the public fields pass.
// Inventory's exact `sellable` count, pricing's record id and basis, and a seller's zone never
// reach the answer; "only N left" passes only in the low band; any refusal or throw is `null`.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PRODUCT = id<'Product'>(0x900);
const OFFER = id<'Offer'>(0x1001);
const VARIANT = id<'Variant'>(0x2001);
const SELLER = id<'Seller'>(0x5001);
const KEY = { offerId: OFFER, variantId: VARIANT };
const PRICE_KEY = `${OFFER}/${VARIANT}`;

const boom = (): never => {
  throw new Error('down');
};

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('product detail sources in market %s', (code, currency) => {
  const context = testCallContext(
    testMarketContext(code, 'default'),
    'anonymous',
    'sources-abcdef',
  );
  const price: Money = { amount: 1299n, currency };

  const sources = (facades: {
    catalog?: Partial<CatalogFacade>;
    pricing?: Partial<PricingFacade>;
    inventory?: Partial<InventoryFacade>;
    sellers?: Partial<SellersFacade>;
  }) =>
    new FacadeProductDetailSources(
      (facades.catalog ?? {}) as CatalogFacade,
      (facades.pricing ?? {}) as PricingFacade,
      (facades.inventory ?? {}) as InventoryFacade,
      (facades.sellers ?? {}) as SellersFacade,
    );

  it('passes status and onlyLeft only, never the sellable count', async () => {
    const stock = await sources({
      inventory: {
        availability: () =>
          Promise.resolve(ok(new Map([[PRICE_KEY, { sellable: 7, status: 'low', onlyLeft: 3 }]]))),
      },
    }).availability(context, [KEY]);
    expect([...(stock ?? new Map()).values()]).toEqual([{ status: 'low', onlyLeft: 3 }]);
    expect(JSON.stringify([...(stock ?? new Map()).values()])).not.toMatch(/sellable|7/u);
  });

  it('drops onlyLeft outside the low band', async () => {
    const stock = await sources({
      inventory: {
        availability: () =>
          Promise.resolve(
            ok(new Map([[PRICE_KEY, { sellable: 40, status: 'in-stock', onlyLeft: 40 }]])),
          ),
      },
    }).availability(context, [KEY]);
    expect([...(stock ?? new Map()).values()]).toEqual([{ status: 'in-stock', onlyLeft: null }]);
  });

  it('passes the price, tax flag and special end, never the record id or basis', async () => {
    const ends = Temporal.Instant.from('2026-10-21T00:00:00Z');
    const prices = await sources({
      pricing: {
        effectivePrices: () =>
          Promise.resolve(
            ok(
              new Map([
                [
                  PRICE_KEY,
                  {
                    price,
                    taxInclusive: true,
                    recordId: id<'SpecialPriceRecord'>(0x77),
                    basis: 'special' as const,
                    specialEndsAt: ends,
                  },
                ],
              ]),
            ),
          ),
      },
    }).prices(context, [KEY]);
    const only = prices?.get(`${OFFER}/${VARIANT}`);
    expect(only).toEqual({ price, taxInclusive: true, special: { endsAt: ends } });
    expect(Object.keys(only ?? {})).not.toContain('recordId');
    expect(Object.keys(only ?? {})).not.toContain('basis');
  });

  it('passes the store name and minimum order only', async () => {
    const sellers = await sources({
      sellers: {
        sellerSummaries: () =>
          Promise.resolve(
            ok([
              {
                sellerId: SELLER,
                exists: true,
                operatingTimezone: { zone: 'Australia/Brisbane', provisional: false },
                minimumOrder: price,
                storeName: 'Corner Store',
              },
            ]),
          ),
      },
    }).sellers(context, [SELLER]);
    expect(sellers?.get(SELLER)).toEqual({ storeName: 'Corner Store', minimumOrder: price });
  });

  it('is null on every refusal and every throw', async () => {
    const denied = () => Promise.resolve(err({ code: 'access.denied' as const }));
    const refusing = sources({
      catalog: { publishedProduct: denied },
      pricing: { effectivePrices: denied },
      inventory: { availability: denied },
      sellers: { sellerSummaries: denied },
    });
    const throwing = sources({
      catalog: { publishedProduct: boom },
      pricing: { effectivePrices: boom },
      inventory: { availability: boom },
      sellers: { sellerSummaries: boom },
    });
    for (const subject of [refusing, throwing]) {
      expect(await subject.product(context, PRODUCT, 'en-AU')).toBeNull();
      expect(await subject.prices(context, [KEY])).toBeNull();
      expect(await subject.availability(context, [KEY])).toBeNull();
      expect(await subject.sellers(context, [SELLER])).toBeNull();
    }
  });
});
