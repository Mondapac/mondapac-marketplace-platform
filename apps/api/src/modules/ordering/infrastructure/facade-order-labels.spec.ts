import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { sellUnitKey, type CatalogFacade, type SellUnitKey } from '../../catalog';
import type { IdentityFacade } from '../../identity';
import type { SellersFacade } from '../../sellers';
import { orderUnitKey } from '../application/ports/order-labels';
import { FacadeOrderLabels } from './facade-order-labels';

// The adapter behind the admin order names, on both Market fixtures: the caller's context goes
// through unchanged, the Market's default locale is asked, each facade's batch limit is kept,
// only requested keys are kept, a refusal is thrown, and identity's access.denied is "no names".

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const uuid = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const never = {} as never;

describe.each(['AU', 'ZZ'] as const)('order label adapter in market %s', (code) => {
  const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'anonymous');

  it('asks catalog in batches of 200, with the context and the Market default locale', async () => {
    const keys = Array.from({ length: 201 }, (_, n) => ({
      offerId: uuid(1000 + n) as Id<'Offer'>,
      variantId: uuid(1) as Id<'Variant'>,
    }));
    const calls: { context: unknown; size: number; locale: unknown }[] = [];
    const catalog = {
      sellUnitLabels: (c: unknown, batch: readonly SellUnitKey[], locale: unknown) => {
        calls.push({ context: c, size: batch.length, locale });
        return Promise.resolve(
          ok(
            new Map([
              ...batch.map((k) => [sellUnitKey(k), { productName: 'Dates', variantLabel: null }]),
              ['extra:key', { productName: 'Extra', variantLabel: null }],
            ] as [string, { productName: string; variantLabel: null }][]),
          ),
        );
      },
    } as unknown as CatalogFacade;

    const labels = await new FacadeOrderLabels(catalog, never, never, markets).unitLabelsOf(
      context,
      keys,
    );

    const locale = markets.get(context.market.marketId).defaultLocale;
    expect(calls).toEqual([
      { context, size: 200, locale },
      { context, size: 1, locale },
    ]);
    expect(labels.size).toBe(201);
    expect(labels.get(orderUnitKey(keys[200]!))).toEqual({
      productName: 'Dates',
      variantLabel: null,
    });
  });

  it('throws when catalog or sellers refuse', async () => {
    const catalog = {
      sellUnitLabels: () => Promise.resolve(err({ code: 'batch.too-large' as const })),
    } as unknown as CatalogFacade;
    const sellers = {
      sellerSummaries: () => Promise.resolve(err({ code: 'sellers.unavailable' as const })),
    } as unknown as SellersFacade;
    const adapter = new FacadeOrderLabels(catalog, sellers, never, markets);
    const key = { offerId: uuid(1) as Id<'Offer'>, variantId: uuid(2) as Id<'Variant'> };

    await expect(adapter.unitLabelsOf(context, [key])).rejects.toThrow();
    await expect(adapter.storeNamesOf(context, [uuid(3) as Id<'Seller'>])).rejects.toThrow();
  });

  it('keeps only the approved store names of the requested sellers', async () => {
    const [a, b] = [uuid(10), uuid(11)] as Id<'Seller'>[];
    const sellers = {
      sellerSummaries: () =>
        Promise.resolve(
          ok([
            { sellerId: a, exists: true, storeName: 'Al Noor' },
            { sellerId: b, exists: true, storeName: null },
            { sellerId: uuid(12), exists: true, storeName: 'Not asked' },
          ]),
        ),
    } as unknown as SellersFacade;

    const names = await new FacadeOrderLabels(never, sellers, never, markets).storeNamesOf(
      context,
      [a!, b!, a!],
    );

    expect([...names]).toEqual([[a, 'Al Noor']]);
  });

  it("answers no customers on identity's access.denied, and throws on any other refusal", async () => {
    const customer = uuid(20) as Id<'Account'>;
    const identityAnswering = (answer: unknown) =>
      ({ customerAccountSummaries: () => Promise.resolve(answer) }) as unknown as IdentityFacade;

    const denied = new FacadeOrderLabels(
      never,
      never,
      identityAnswering(err({ code: 'access.denied' })),
      markets,
    );
    const invalid = new FacadeOrderLabels(
      never,
      never,
      identityAnswering(err({ code: 'validation.failed', fields: [] })),
      markets,
    );
    const found = new FacadeOrderLabels(
      never,
      never,
      identityAnswering(ok([{ accountId: customer, displayName: null, email: 'j@example.com' }])),
      markets,
    );

    expect((await denied.customersOf(context, [customer])).size).toBe(0);
    await expect(invalid.customersOf(context, [customer])).rejects.toThrow();
    expect([...(await found.customersOf(context, [customer]))]).toEqual([
      [customer, { displayName: null, email: 'j@example.com' }],
    ]);
  });
});
