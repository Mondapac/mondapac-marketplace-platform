import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { REVIEW_QUEUE_SELLERS_MAX, ReviewQueueList } from './review-queue-list.use-case';

// The Offer filters of the review queue (slice 5): `reasons` resolves, in the read unit, to the
// waiting Offers whose latest first-publication decision carries one of them; `categoryId` goes
// to the Offer reads. Both keep Offers only and are refused for product revisions. `sellers` is
// the seller filter's options: the stores with rows of the kinds `kind` keeps, whatever the
// other filters, named and sorted.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CATEGORY = ID(0xc1);

describe.each(['AU', 'ZZ'] as const)('review queue Offer filters in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: null,
      }),
    );
  const check: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
  let offerFilters: unknown[];
  let offerCounts: unknown[];
  let revisionReads: number;
  let reasonAsks: unknown[];
  let sellerAsks: unknown[];
  let inUnit: boolean;
  let sellerIds: readonly string[];
  let names: Map<string, string>;

  const build = () =>
    new ReviewQueueList(createUseCaseGate(markets, check), {
      unitOfWork: {
        run: async (_m: MarketContext, work: () => Promise<unknown>) => {
          inUnit = true;
          try {
            return await work();
          } finally {
            inUnit = false;
          }
        },
      } as never,
      offers: {
        listPendingReview: (_m: MarketContext, _page: unknown, filter: unknown) => {
          offerFilters.push(filter);
          return Promise.resolve([]);
        },
      } as never,
      ownReader: {
        pendingQueueSellerIds: (
          m: MarketContext,
          kinds: { offers: boolean; revisions: boolean },
          limit: number,
        ) => {
          expect(inUnit).toBe(true);
          expect(m.marketId).toBe(market.marketId);
          sellerAsks.push({ kinds, limit });
          return Promise.resolve(sellerIds);
        },
        pendingReviewCount: (_m: MarketContext, filter?: unknown) => {
          if (filter !== undefined) offerCounts.push(filter);
          return Promise.resolve(filter === undefined ? 7 : 1);
        },
        pendingRevisionCount: () => Promise.resolve(5),
        listPendingRevisions: () => {
          revisionReads += 1;
          return Promise.resolve([]);
        },
        productLabels: () => Promise.resolve([]),
      } as never,
      policy: { locales: () => ({ default: 'en', supported: ['en'] }) } as never,
      sellerNames: {
        storeNames: (_c: CallContext, ids: readonly Id<'Seller'>[]) =>
          Promise.resolve(
            new Map(ids.flatMap((id) => (names.has(id) ? [[id, names.get(id)!] as const] : []))),
          ),
      },
      storeSearch: { sellersMatching: () => Promise.resolve({ sellerIds: [], capped: false }) },
      gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      productApproveProbe: { probe: () => Promise.resolve(false) } as never,
      queueFacts: {
        pendingFirstPublicationsWithReasons: (m: MarketContext, reasons: readonly string[]) => {
          expect(inUnit).toBe(true);
          expect(m.marketId).toBe(market.marketId);
          reasonAsks.push(reasons);
          return Promise.resolve([ID(0xf1), ID(0xf2)] as never);
        },
        firstPublicationReasons: () => Promise.resolve(new Map()),
        openTagTypes: () => Promise.resolve(new Map()),
      },
    });

  beforeEach(() => {
    offerFilters = [];
    offerCounts = [];
    revisionReads = 0;
    reasonAsks = [];
    sellerAsks = [];
    inUnit = false;
    sellerIds = [];
    names = new Map();
  });

  it('resolves reasons to the waiting Offers in the read unit and keeps Offers only', async () => {
    const result = await build().execute(context(), {
      kind: 'offer-first-publication',
      reasons: 'probation,handling,probation',
      categoryId: CATEGORY,
    });
    expect(result.ok).toBe(true);
    expect(reasonAsks).toEqual([['probation', 'handling']]);
    const filter = { categoryId: CATEGORY, offerIds: [ID(0xf1), ID(0xf2)] };
    expect(offerFilters[0]).toMatchObject(filter);
    expect(offerCounts[0]).toMatchObject(filter);
    expect(revisionReads).toBe(0);
    expect(result.ok && result.value.total).toBe(1);
    expect(result.ok && result.value.totals['offer-first-publication']).toBe(7);
  });

  it('reads Offers only for an Offer filter without a kind, and takes an array of reasons', async () => {
    const result = await build().execute(context(), { reasons: ['certificate-badge'] });
    expect(result.ok).toBe(true);
    expect(reasonAsks).toEqual([['certificate-badge']]);
    expect(revisionReads).toBe(0);
  });

  it('reads no reasons when the filter is absent', async () => {
    const result = await build().execute(context(), { kind: 'offer-first-publication' });
    expect(result.ok).toBe(true);
    expect(reasonAsks).toEqual([]);
    expect(offerFilters[0]).not.toHaveProperty('offerIds');
    expect(offerFilters[0]).not.toHaveProperty('categoryId');
  });

  it.each([
    [{ reasons: 'nope' }, 'reasons', 'value'],
    [{ reasons: 12 }, 'reasons', 'type'],
    [{ categoryId: 'abc' }, 'categoryId', 'format'],
    [{ kind: 'product-revision', reasons: 'probation' }, 'reasons', 'not-allowed'],
    [{ kind: 'product-revision', categoryId: CATEGORY }, 'categoryId', 'not-allowed'],
    [{ hasImages: true, reasons: 'probation' }, 'reasons', 'not-allowed'],
    [{ firstPublication: false, categoryId: CATEGORY }, 'categoryId', 'not-allowed'],
  ])('refuses %j as validation.failed before any read', async (input, path, reason) => {
    expect(await build().execute(context(), input)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: reason }] },
    });
    expect(reasonAsks).toEqual([]);
    expect(offerFilters).toEqual([]);
  });

  it('offers the stores of the kinds kept, named first by name, whatever the other filters', async () => {
    sellerIds = [ID(0x53), ID(0x51), ID(0x52)];
    names = new Map([
      [ID(0x51), 'Zaytoon'],
      [ID(0x53), 'Al Noor'],
    ]);
    const result = await build().execute(context(), {
      kind: 'offer-first-publication',
      sellerId: ID(0x51),
      reasons: 'probation',
    });
    expect(result.ok).toBe(true);
    expect(sellerAsks).toEqual([
      { kinds: { offers: true, revisions: false }, limit: REVIEW_QUEUE_SELLERS_MAX + 1 },
    ]);
    expect(result.ok && result.value.sellers).toEqual([
      { sellerId: ID(0x53), storeName: 'Al Noor' },
      { sellerId: ID(0x51), storeName: 'Zaytoon' },
      { sellerId: ID(0x52), storeName: null },
    ]);
    expect(result.ok && result.value.sellersCapped).toBe(false);
  });

  it('says when more stores have rows than the options hold', async () => {
    sellerIds = Array.from({ length: REVIEW_QUEUE_SELLERS_MAX + 1 }, (_, n) => ID(0x1000 + n));
    const result = await build().execute(context(), {});
    expect(sellerAsks).toEqual([
      { kinds: { offers: true, revisions: true }, limit: REVIEW_QUEUE_SELLERS_MAX + 1 },
    ]);
    expect(result.ok && result.value.sellers).toHaveLength(REVIEW_QUEUE_SELLERS_MAX);
    expect(result.ok && result.value.sellersCapped).toBe(true);
  });
});
