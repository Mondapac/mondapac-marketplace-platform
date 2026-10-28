import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_PUBLISHED_IMAGES, type PublishedImageRef } from '../../contracts/catalog.facade';
import { CatalogFacadeImplementation } from '../../presentation/catalog.facade';
import type { PublishedImagesReader } from '../ports/published-images.reader';
import { PublishedProductImagesQuery } from './published-product-images.use-case';

// `publishedProductImages` through the facade on both Market fixtures: the request is checked
// whole before any read, the read runs in one read-only unit on the context's Market only, and
// the answer is ids and sizes of what the reader says is public. The database rules (published
// revision only, taken-down skipped) are in test/db/catalog-published-images.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const product = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Product'>;
const ref = (n: number): PublishedImageRef => ({
  imageId:
    `01990000-0000-7000-8000-${(0x700 + n).toString(16).padStart(12, '0')}` as Id<'ProductImage'>,
  width: 1600,
  height: 1200,
});

describe.each(TEST_MARKETS)('publishedProductImages in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const reads: { market: string; ids: readonly Id<'Product'>[]; perProduct: number }[] = [];
  let known = new Map<Id<'Product'>, readonly PublishedImageRef[]>();
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
  const reader: PublishedImagesReader = {
    imagesOf: (readMarket, ids, perProduct) => {
      reads.push({ market: readMarket.marketId, ids, perProduct });
      return Promise.resolve(new Map([...known].filter(([id]) => ids.includes(id))));
    },
    renditionKey: () => Promise.resolve(null),
  };
  const facade = new CatalogFacadeImplementation({
    offerSellUnits: undefined as never,
    offerSellUnitsSystem: undefined as never,
    offerNamesSystem: undefined as never,
    sellUnitLabels: undefined as never,
    offerTaxCategories: undefined as never,
    offerListings: undefined as never,
    offerListingsSystem: undefined as never,
    offerBadges: undefined as never,
    publishedProduct: undefined as never,
    publishedProductImages: new PublishedProductImagesQuery(gate, {
      unitOfWork,
      publishedImagesReader: reader,
    }),
    pendingProductRevisions: undefined as never,
    sellerProductOwners: undefined as never,
    productsForLinking: undefined as never,
  });
  const anonymous = testCallContext(market, 'anonymous');
  beforeEach(() => {
    units.length = 0;
    reads.length = 0;
    known = new Map();
  });

  it('declares the anonymous rule under its own name', () => {
    expect(PublishedProductImagesQuery.access).toEqual({
      name: 'catalog.published-product-images',
      rule: { kind: 'anonymous' },
    });
  });

  it('answers the public photos of the asked products in one read-only unit, at most 8 each', async () => {
    known.set(product(1), [ref(1), ref(2)]);

    const result = await facade.publishedProductImages(anonymous, [
      product(1),
      product(2),
      product(1),
    ]);

    expect(result).toEqual({ ok: true, value: new Map([[product(1), [ref(1), ref(2)]]]) });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(reads).toEqual([
      { market: code, ids: [product(1), product(2)], perProduct: MAX_PUBLISHED_IMAGES },
    ]);
    expect(MAX_PUBLISHED_IMAGES).toBe(8);
  });

  it('reads nothing for an empty request', async () => {
    expect(await facade.publishedProductImages(anonymous, [])).toEqual({
      ok: true,
      value: new Map(),
    });
    expect(units).toEqual([]);
  });

  it('refuses a malformed id, whole and before any read', async () => {
    const result = await facade.publishedProductImages(anonymous, [
      product(1),
      'nope' as Id<'Product'>,
    ]);

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'productIds', code: 'format' }] },
    });
    expect(units).toEqual([]);
  });

  it('refuses more than 200 products, whole', async () => {
    const many = [...Array(201).keys()].map((n) => product(n + 1));

    expect(await facade.publishedProductImages(anonymous, many)).toEqual({
      ok: false,
      error: { code: 'batch.too-large' },
    });
    expect(await facade.publishedProductImages(anonymous, many.slice(0, 200))).toMatchObject({
      ok: true,
    });
  });
});
