import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { sellUnitKey, type CatalogFacade } from '../../catalog';
import type { SellersFacade, SellerSummary } from '../../sellers';
import { heldUnitKey } from '../application/ports/held-labels';
import { CatalogHeldUnitLabels } from './catalog-held-unit-labels';
import { SellersStoreNames } from './sellers-store-names';

// The two adapters behind the held-price names, on both Market fixtures: the caller's context
// goes through unchanged, the Market's default locale is asked, only requested keys are kept,
// and a refusal is thrown (never read as "no label").

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const uuid = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('held-price name adapters in market %s', (code) => {
  const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const key = { offerId: uuid(1) as Id<'Offer'>, variantId: uuid(2) as Id<'Variant'> };

  it('asks catalog once, with the context and the Market default locale', async () => {
    const calls: unknown[][] = [];
    const catalog = {
      sellUnitLabels: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(
          ok(
            new Map([
              [sellUnitKey(key), { productName: 'Dates', variantLabel: '1 kg' }],
              ['extra:key', { productName: 'Extra', variantLabel: null }],
            ]),
          ),
        );
      },
    } as unknown as CatalogFacade;
    const labels = await new CatalogHeldUnitLabels(catalog, markets).labelsOf(context, [key]);
    expect([...labels]).toEqual([
      [heldUnitKey(key), { productName: 'Dates', variantLabel: '1 kg' }],
    ]);
    expect(calls).toEqual([[context, [key], markets.get(context.market.marketId).defaultLocale]]);
  });

  it('throws when catalog refuses', async () => {
    const catalog = {
      sellUnitLabels: () => Promise.resolve(err({ code: 'batch.too-large' as const })),
    } as unknown as CatalogFacade;
    await expect(
      new CatalogHeldUnitLabels(catalog, markets).labelsOf(context, [key]),
    ).rejects.toThrow();
  });

  it('reads only storeName from sellerSummaries, with the context unchanged', async () => {
    const [a, b, c] = [uuid(10), uuid(11), uuid(12)] as Id<'Seller'>[];
    const calls: unknown[][] = [];
    const summaries: SellerSummary[] = [
      { sellerId: a!, exists: true, storeName: 'Al Noor' },
      { sellerId: b!, exists: true, storeName: null },
      { sellerId: uuid(99) as Id<'Seller'>, exists: true, storeName: 'Not asked' },
    ];
    const sellers = {
      sellerSummaries: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(ok(summaries));
      },
    } as unknown as SellersFacade;
    const names = await new SellersStoreNames(sellers).namesOf(context, [a!, b!, c!]);
    expect([...names]).toEqual([[a, 'Al Noor']]);
    expect(calls).toEqual([[context, [a, b, c]]]);
  });

  it('throws when sellers refuses', async () => {
    const sellers = {
      sellerSummaries: () => Promise.resolve(err({ code: 'sellers.unavailable' as const })),
    } as unknown as SellersFacade;
    await expect(
      new SellersStoreNames(sellers).namesOf(context, [uuid(10) as Id<'Seller'>]),
    ).rejects.toThrow();
  });
});
