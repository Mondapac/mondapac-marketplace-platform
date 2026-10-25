import { err, ok } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CatalogAssistantFacade, CatalogFacade } from '../../catalog';
import type { SellersFacade } from '../../sellers';
import { FacadeSlideTargets } from './facade-slide-targets';

// The adapter over the public facades, in both Market fixtures: it passes the caller's context on,
// keeps only what the facades call live (a published product, a category in the public tree, a
// seller who may sell) and answers null when a facade fails, so approval fails closed.

const CATEGORY = '01990000-0000-7000-8000-0000000000c1';
const PRODUCT = '01990000-0000-7000-8000-0000000000d1';
const SELLER = '01990000-0000-7000-8000-0000000000e1';
const SUSPENDED = '01990000-0000-7000-8000-0000000000e2';
const markets = { get: () => ({ defaultLocale: 'en' }) } as unknown as MarketRegistry;

describe.each([
  ['AU', 'ZZ'],
  ['ZZ', 'AU'],
] as const)('slide targets over the facades in market %s (other %s)', (code, otherCode) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const seen: string[] = [];
  const build = (overrides: { products?: boolean; categories?: boolean; sellers?: boolean } = {}) =>
    new FacadeSlideTargets(
      {
        publishedProduct: (c: typeof context, id: string) => {
          seen.push(c.market.marketId);
          // Only this Market has the product.
          return Promise.resolve(
            overrides.products === false
              ? err({ code: 'unavailable' })
              : ok(c.market.marketId === code && id === PRODUCT ? { id } : null),
          );
        },
      } as unknown as CatalogFacade,
      {
        categories: (c: typeof context) =>
          Promise.resolve(
            overrides.categories === false
              ? err({ code: 'unavailable' })
              : ok(c.market.marketId === code ? [{ id: CATEGORY }] : []),
          ),
      } as unknown as CatalogAssistantFacade,
      {
        sellingEligibility: (_c: typeof context, ids: readonly string[]) =>
          Promise.resolve(
            overrides.sellers === false
              ? err({ code: 'unavailable' })
              : ok(new Map(ids.map((id) => [id, { eligible: id === SELLER }]))),
          ),
      } as unknown as SellersFacade,
      markets,
    );
  const all = [
    { type: 'category', id: CATEGORY },
    { type: 'product', id: PRODUCT },
    { type: 'seller', id: SELLER },
    { type: 'seller', id: SUSPENDED },
  ] as const;

  it('keeps the live targets and drops a suspended seller', async () => {
    const live = await build().live(context, all);
    expect([...live!].sort()).toEqual(
      [`category:${CATEGORY}`, `product:${PRODUCT}`, `seller:${SELLER}`].sort(),
    );
    expect(seen).toContain(code);
  });

  it('finds nothing of this Market in the other', async () => {
    const theirs = testCallContext(testMarketContext(otherCode, 'default'), 'anonymous');
    const live = await build().live(theirs, all.slice(0, 2));
    expect([...live!]).toEqual([]);
  });

  it.each([{ products: false }, { categories: false }, { sellers: false }])(
    'answers null when a facade fails (%o)',
    async (overrides) => {
      expect(await build(overrides).live(context, all)).toBeNull();
    },
  );
});
