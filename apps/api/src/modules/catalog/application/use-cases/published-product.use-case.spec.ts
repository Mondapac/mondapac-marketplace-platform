import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { PublishedProduct } from '../../contracts/catalog.facade';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import type { PublishedProductReader } from '../ports/published-product.reader';
import { PublishedProductQuery } from './published-product.use-case';

// `publishedProduct` through the facade on both Market fixtures: the request is checked whole
// before any read, the read runs in one read-only unit on the context's Market only, the fallback
// locale is the Market's default, and an unpublished or unknown product is null. The database
// behaviour of the reader is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const productId = '01990000-0000-7000-8000-000000000001' as Id<'Product'>;

const published = (id: Id<'Product'>): PublishedProduct => ({
  productId: id,
  publishedRevisionId: '01990000-0000-7000-8000-0000000000a1' as Id<'ProductRevision'>,
  name: 'Dates',
  shortDescription: null,
  description: 'Sweet',
  categoryIds: ['01990000-0000-7000-8000-0000000000ca' as Id<'Category'>],
  variants: [
    { variantId: '01990000-0000-7000-8000-0000000000b1' as Id<'Variant'>, position: 0, label: 'S' },
  ],
});

describe.each(TEST_MARKETS)('publishedProduct in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const policy = new ConfigCatalogMarketPolicy(markets);
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const reads: { market: string; id: Id<'Product'>; locales: object }[] = [];
  let known = new Map<Id<'Product'>, PublishedProduct>();
  const unitOfWork = {
    run: <T, E>(
      unitMarket: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push({ market: unitMarket.marketId, options });
      return work();
    },
  } as unknown as UnitOfWork;
  const reader: PublishedProductReader = {
    read: (readMarket, id, locales) => {
      reads.push({ market: readMarket.marketId, id, locales });
      return Promise.resolve(known.get(id) ?? null);
    },
  };
  const facade = new CatalogFacadeImplementation({
    offerSellUnits: undefined as never,
    offerSellUnitsSystem: undefined as never,
    offerNamesSystem: undefined as never,
    sellUnitLabels: undefined as never,
    offerTaxCategories: undefined as never,
    offerListings: undefined as never,
    offerListingsSystem: undefined as never,
    publishedProduct: new PublishedProductQuery(gate, {
      unitOfWork,
      publishedProductReader: reader,
      policy,
    }),
    pendingProductRevisions: undefined as never,
    sellerProductOwners: undefined as never,
  });
  const anonymous = testCallContext(market, 'anonymous');
  beforeEach(() => {
    units.length = 0;
    reads.length = 0;
    known = new Map();
  });

  it('declares the anonymous rule under its own name', () => {
    expect(PublishedProductQuery.access).toEqual({
      name: 'catalog.published-product',
      rule: { kind: 'anonymous' },
    });
  });

  it('answers the published product in one read-only unit, with the Market default as fallback', async () => {
    known.set(productId, published(productId));

    const result = await facade.publishedProduct(anonymous, productId, 'xx-Latn');

    expect(result).toEqual({ ok: true, value: published(productId) });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(reads).toEqual([
      {
        market: code,
        id: productId,
        locales: { requested: 'xx-Latn', fallback: policy.locales(market).default },
      },
    ]);
  });

  it('answers null for an unknown or unpublished product', async () => {
    const result = await facade.publishedProduct(anonymous, productId, 'en-AU');

    expect(result).toEqual({ ok: true, value: null });
    expect(reads).toHaveLength(1);
  });

  it('answers an authenticated seller like any caller', async () => {
    known.set(productId, published(productId));
    const seller = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: '01990000-0000-7000-8000-00000000a002' as Id<'Account'>,
        sessionId: '01990000-0000-7000-8000-00000000a001' as Id<'Session'>,
        sellerId: '01990000-0000-7000-8000-00000000a003' as Id<'Seller'>,
      }),
      'published-product-0001',
    );

    const result = await facade.publishedProduct(seller, productId, 'en-AU');

    expect(result.ok && result.value?.productId).toBe(productId);
  });

  it.each([
    ['not-a-uuid', 'en-AU', ['productId']],
    [productId, 'not a locale', ['locale']],
    ['', '', ['productId', 'locale']],
  ])('refuses %j in %j before any read', async (id, locale, paths) => {
    const result = await facade.publishedProduct(anonymous, id as Id<'Product'>, locale);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: paths.map((path) => ({ path, code: 'format' })),
      },
    });
    expect(units).toEqual([]);
    expect(reads).toEqual([]);
  });
});
