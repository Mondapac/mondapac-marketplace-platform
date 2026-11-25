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

// QA additions (Sajad, PR 1334): the barcode reasons the first spec leaves unexercised
// (already-selling, not-allowed), GTIN normalisation of 8/12/13-digit forms, de-duplication and
// the closed input, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');

// Valid check digits: GTIN-8, UPC-A (12), EAN-13 and their 14-digit forms.
const G8 = '96385074';
const G12 = '036000291452';
const G13 = '4006381333931';
const D = (g: string) => g.padStart(14, '0');

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
    primaryImageId: null,
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

  it('answers already-selling and not-allowed with their reasons, and found for a free product', async () => {
    const free = row();
    const selling = row(true);
    const away = row();
    const { useCase } = rig({
      matches: [
        { gtin: D(G8), row: selling, inScope: true },
        { gtin: D(G12), row: away, inScope: false },
        { gtin: D(G13), row: free, inScope: true },
      ],
    });
    const result = await useCase.execute(contextOf('seller'), { barcodes: [G8, G12, G13] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.barcodeResults.map((line) => line.status)).toEqual([
      'already-selling',
      'not-allowed',
      'found',
    ]);
    // A product outside the seller's categories is never handed back, only the reason.
    expect(result.value.barcodeResults[1]?.product).toBeNull();
    expect(result.value.barcodeResults[0]?.product?.alreadySelling).toBe(true);
  });

  it('prefers the in-scope product when one barcode matches in and out of scope', async () => {
    const inside = row();
    const outside = row();
    const { useCase } = rig({
      matches: [
        { gtin: D(G13), row: outside, inScope: false },
        { gtin: D(G13), row: inside, inScope: true },
      ],
    });
    const result = await useCase.execute(contextOf('seller'), { barcodes: [G13] });
    expect(result.ok && result.value.barcodeResults[0]?.product?.productId).toBe(inside.productId);
  });

  it('asks the reader for the 14-digit form of 8, 12 and 13-digit barcodes, once each', async () => {
    const asked: (readonly string[])[] = [];
    const { useCase } = rig();
    const spied = useCase as unknown as {
      deps: {
        platformSearchReader: {
          lookupGtins: (m: unknown, q: { gtins: readonly string[] }) => unknown;
        };
      };
    };
    spied.deps.platformSearchReader.lookupGtins = (_m, q) => {
      asked.push(q.gtins);
      return Promise.resolve([]);
    };
    await useCase.execute(contextOf('seller'), {
      barcodes: [G8, G12, G13, G13, D(G13), ' ', 'abc'],
    });
    // The 13-digit and 14-digit spellings are two pasted lines but one product: both are asked.
    expect(asked[0]).toEqual([D(G8), D(G12), D(G13), D(G13)]);
  });

  it('marks wrong check digits, letters and over-long lines invalid, not-found otherwise', async () => {
    const { useCase } = rig();
    const result = await useCase.execute(contextOf('seller'), {
      barcodes: ['4006381333932', 'ABC123', '1'.repeat(41), G13],
    });
    expect(result.ok && result.value.barcodeResults.map((line) => line.status)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'not-found',
    ]);
    // An over-long line is cut for display.
    expect(result.ok && result.value.barcodeResults[2]?.input).toHaveLength(40);
  });

  it('accepts at most 200 barcodes, strings only, and unknown keys are refused', async () => {
    const { useCase } = rig();
    const tooMany = await useCase.execute(contextOf('seller'), {
      barcodes: Array.from({ length: 201 }, (_, i) => String(i)),
    });
    expect(!tooMany.ok && tooMany.error.code).toBe('validation.failed');
    const notText = await useCase.execute(contextOf('seller'), { barcodes: [1] });
    expect(!notText.ok && notText.error.code).toBe('validation.failed');
    const unknown = await useCase.execute(contextOf('seller'), { sellerId: 'x' } as Record<
      string,
      unknown
    >);
    expect(!unknown.ok && unknown.error.code).toBe('validation.failed');
    for (const page of [201, 1.5, 'abc', -1]) {
      const refused = await useCase.execute(contextOf('seller'), { page });
      expect(!refused.ok && refused.error.code).toBe('validation.failed');
    }
  });

  it('turns a blank q into a listing and sends the page offset', async () => {
    const { useCase, queries } = rig();
    await useCase.execute(contextOf('seller'), { q: '   ', page: '3' });
    expect(queries[0]).toMatchObject({ text: null, gtins: [], offset: 50, limit: 25 });
  });

  it('answers access.unavailable when the seller scope cannot be read (fail closed)', async () => {
    const queries: unknown[] = [];
    const useCase = new OwnPlatformProductSearch(gate, {
      unitOfWork: {
        run: () => Promise.reject(new Error('must not open')),
      } as unknown as UnitOfWork,
      policy: { locales: () => ({ default: 'en' }) } as never,
      sellerCategories: {
        allowedCategoryIdsForSeller: () =>
          Promise.resolve({ ok: false as const, error: { code: 'access.unavailable' } } as never),
      },
      platformSearchReader: {
        search: () => {
          queries.push(1);
          return Promise.resolve({ rows: [], total: 0 });
        },
        lookupGtins: () => Promise.resolve([]),
      },
    });
    const result = await useCase.execute(contextOf('seller'), { q: 'beef' });
    expect(!result.ok && result.error.code).toBe('access.unavailable');
    expect(queries).toHaveLength(0);
  });
});
