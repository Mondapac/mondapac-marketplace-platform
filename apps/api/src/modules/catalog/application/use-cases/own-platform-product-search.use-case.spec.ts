import { Temporal, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  PlatformProductSearchQuery,
  PlatformProductSearchRow,
} from '../ports/platform-product-search.reader';
import { OwnPlatformProductSearch } from './own-platform-product-search.use-case';

// `own-product.platform-search` in memory, on both Market fixtures. The reader's database
// behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');

// A valid GTIN-13 and its 14-digit form.
const EAN = '4006381333931';
const GTIN14 = '04006381333931';

describe.each(['AU', 'ZZ'] as const)('own-product.platform-search in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const sellerId = ids.next<'Seller'>();
  const category = ids.next<'Category'>();

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );

  const row = (alreadySelling = false): PlatformProductSearchRow => ({
    productId: ids.next<'Product'>(),
    productCode: 'P-1',
    name: 'Beef',
    brandName: 'Acme',
    categoryId: category,
    categoryName: 'Meat',
    variantCount: 2,
    alreadySelling,
  });

  function rig(
    options: {
      allowed?: Set<Id<'Category'>>;
      matches?: { gtin: string; row: PlatformProductSearchRow; inScope: boolean }[];
    } = {},
  ) {
    const queries: PlatformProductSearchQuery[] = [];
    const runs: (UnitOfWorkOptions | undefined)[] = [];
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<Result<T, E>>,
        runOptions?: UnitOfWorkOptions,
      ) => {
        runs.push(runOptions);
        return work();
      },
    } as unknown as UnitOfWork;
    const useCase = new OwnPlatformProductSearch(gate, {
      unitOfWork,
      policy: { locales: () => ({ default: 'en' }) } as never,
      sellerCategories: {
        allowedCategoryIdsForSeller: () =>
          Promise.resolve(ok(options.allowed ?? new Set([category]))),
      },
      platformSearchReader: {
        search: (_m, query) => {
          queries.push(query);
          return Promise.resolve({ rows: [row()], total: 1 });
        },
        lookupGtins: () => Promise.resolve(options.matches ?? []),
      },
    });
    return { useCase, queries, runs };
  }

  it('searches inside the seller scope in a read-only unit', async () => {
    const { useCase, queries, runs } = rig();
    const result = await useCase.execute(contextOf('seller'), { q: '  beef ' });
    expect(result.ok && result.value.items).toHaveLength(1);
    expect(queries[0]?.text).toBe('beef');
    expect(queries[0]?.allowedCategoryIds.has(category)).toBe(true);
    expect(runs[0]).toEqual({ readOnly: true });
  });

  it('turns a typed barcode into its 14-digit form', async () => {
    const { useCase, queries } = rig();
    await useCase.execute(contextOf('seller'), { q: EAN });
    expect(queries[0]?.gtins).toEqual([GTIN14]);
  });

  it('says no-activity when the activities allow no category', async () => {
    const { useCase } = rig({ allowed: new Set() });
    const result = await useCase.execute(contextOf('seller'), {});
    expect(result.ok && result.value.notice).toBe('no-activity');
  });

  it('answers each pasted barcode with a reason', async () => {
    const free = row();
    const selling = row(true);
    const { useCase } = rig({
      matches: [
        { gtin: GTIN14, row: free, inScope: true },
        { gtin: '00000000000000', row: selling, inScope: true },
        { gtin: '00000000000017', row: free, inScope: false },
      ],
    });
    const result = await useCase.execute(contextOf('seller'), {
      barcodes: [EAN, 'abc', '96385074'],
    });
    expect(result.ok && result.value.barcodeResults.map((line) => line.status)).toEqual([
      'found',
      'invalid',
      'not-found',
    ]);
  });

  it('refuses unknown keys, long text and a bad page', async () => {
    const { useCase } = rig();
    for (const input of [
      { x: 1 },
      { q: 'a'.repeat(101) },
      { page: 0 },
      { barcodes: 'x' },
      { q: 'a\u0001' },
    ] as Record<string, unknown>[]) {
      const result = await useCase.execute(contextOf('seller'), input);
      expect(!result.ok && result.error.code).toBe('validation.failed');
    }
  });

  it('refuses a caller who is not a seller', async () => {
    const { useCase } = rig();
    const result = await useCase.execute(contextOf('admin'), {});
    expect(!result.ok && result.error.code).toBe('access.denied');
  });
});
