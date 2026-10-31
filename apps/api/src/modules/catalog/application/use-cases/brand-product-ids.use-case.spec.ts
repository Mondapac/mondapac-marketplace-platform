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
import { MAX_BRAND_PRODUCT_IDS } from '../../contracts/catalog.facade';
import type { BrandReader } from '../ports/brand.reader';
import { BrandProductIdsQuery } from './brand-product-ids.use-case';

// `brandProductIds` on both Market fixtures: anonymous, one read-only unit on the context's Market,
// ids only, an empty answer (and no read) for a malformed slug, and a cut list says so. The
// database behaviour of the reader (live rule, active brand only) is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const product = (n: number): Id<'Product'> =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Product'>;

describe.each(TEST_MARKETS)('brandProductIds in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, null);
  const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
  const reads: { market: string; slug: string; limit: number }[] = [];
  let live = new Map<string, Id<'Product'>[]>();
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
  const brandReader = {
    liveProductIds: (readMarket: MarketContext, slug: string, limit: number) => {
      reads.push({ market: readMarket.marketId, slug, limit });
      return Promise.resolve((live.get(`${readMarket.marketId}:${slug}`) ?? []).slice(0, limit));
    },
  } as unknown as BrandReader;
  const query = new BrandProductIdsQuery(gate, { unitOfWork, brandReader });
  const anonymous = testCallContext(market, 'anonymous');

  beforeEach(() => {
    units.length = 0;
    reads.length = 0;
    live = new Map();
  });

  it('declares the anonymous rule under its own name', () => {
    expect(BrandProductIdsQuery.access).toEqual({
      name: 'catalog.brand-product-ids',
      rule: { kind: 'anonymous' },
    });
  });

  it('answers the ids in one read-only unit of the context Market', async () => {
    live.set(`${code}:saffron-co`, [product(1), product(2)]);

    const result = await query.execute(anonymous, { slug: 'saffron-co' });

    expect(result).toEqual({
      ok: true,
      value: { productIds: [product(1), product(2)], truncated: false },
    });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(reads).toEqual([{ market: code, slug: 'saffron-co', limit: MAX_BRAND_PRODUCT_IDS + 1 }]);
  });

  it('answers an empty list for a brand with no live products or an unknown one', async () => {
    const result = await query.execute(anonymous, { slug: 'no-such-brand' });

    expect(result).toEqual({ ok: true, value: { productIds: [], truncated: false } });
  });

  it('does not leak the products of another Market', async () => {
    const other = TEST_MARKETS.find((m) => m !== code)!;
    live.set(`${other}:saffron-co`, [product(9)]);

    const result = await query.execute(anonymous, { slug: 'saffron-co' });

    expect(result).toEqual({ ok: true, value: { productIds: [], truncated: false } });
  });

  it('cuts the list at the maximum and says so', async () => {
    live.set(
      `${code}:big-brand`,
      Array.from({ length: MAX_BRAND_PRODUCT_IDS + 1 }, (_, i) => product(i + 1)),
    );

    const result = await query.execute(anonymous, { slug: 'big-brand' });

    expect(result.ok && result.value.productIds).toHaveLength(MAX_BRAND_PRODUCT_IDS);
    expect(result.ok && result.value.truncated).toBe(true);
  });

  it.each(['Saffron', 'a_b', '', '-x', 'x'.repeat(81), 42, null])(
    'answers empty without reading for the malformed slug %j',
    async (slug) => {
      const result = await query.execute(anonymous, { slug: slug as string });

      expect(result).toEqual({ ok: true, value: { productIds: [], truncated: false } });
      expect(reads).toEqual([]);
      expect(units).toEqual([]);
    },
  );
});
