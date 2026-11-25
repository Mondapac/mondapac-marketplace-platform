import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
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
import { ReviewQueueList } from './review-queue-list.use-case';

// The submitted range of the review queue: `submittedFrom` inclusive, `submittedTo` exclusive, read
// the same for both kinds of row (Offers and product revisions), and refused as validation.failed
// before any read when it is not an ISO 8601 instant with an offset or goes backwards.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('review queue submitted range in market %s', (code) => {
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
  let revisionFilters: unknown[];
  let offerCounts: unknown[];
  let revisionCounts: unknown[];
  let reads: number;

  const build = () =>
    new ReviewQueueList(createUseCaseGate(markets, check), {
      unitOfWork: {
        run: async (_m: MarketContext, work: () => Promise<unknown>) => {
          reads += 1;
          return work();
        },
      } as never,
      offers: {
        listPendingReview: (_m: MarketContext, _page: unknown, filter: unknown) => {
          offerFilters.push(filter);
          return Promise.resolve([]);
        },
      } as never,
      ownReader: {
        pendingReviewCount: (_m: MarketContext, filter?: unknown) => {
          offerCounts.push(filter);
          return Promise.resolve(filter === undefined ? 7 : 1);
        },
        pendingRevisionCount: (_m: MarketContext, filter?: unknown) => {
          revisionCounts.push(filter);
          return Promise.resolve(filter === undefined ? 5 : 1);
        },
        listPendingRevisions: (_m: MarketContext, _p: unknown, _l: string, filter: unknown) => {
          revisionFilters.push(filter);
          return Promise.resolve([]);
        },
        productLabels: () => Promise.resolve([]),
      } as never,
      policy: { locales: () => ({ default: 'en', supported: ['en'] }) } as never,
      sellerNames: { storeNames: () => Promise.resolve(new Map()) },
      storeSearch: { sellersMatching: () => Promise.resolve({ sellerIds: [], capped: false }) },
      gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      productApproveProbe: { probe: () => Promise.resolve(false) } as never,
      queueFacts: {
        firstPublicationReasons: () => Promise.resolve(new Map()),
        openTagTypes: () => Promise.resolve(new Map()),
      },
    });

  beforeEach(() => {
    offerFilters = [];
    revisionFilters = [];
    offerCounts = [];
    revisionCounts = [];
    reads = 0;
  });

  it('hands both kinds the same window, read on the offset the panel sends', async () => {
    const result = await build().execute(context(), {
      submittedFrom: '2026-11-01T00:00:00+10:00',
      submittedTo: '2026-11-08T00:00:00+10:00',
    });
    expect(result.ok).toBe(true);
    const window = {
      submittedFrom: Temporal.Instant.from('2026-10-31T14:00:00Z'),
      submittedTo: Temporal.Instant.from('2026-11-07T14:00:00Z'),
    };
    // A range is a filter: the counts are the filtered ones, not the whole queue's.
    expect(offerCounts.at(-1)).toMatchObject(window);
    expect(revisionCounts.at(-1)).toMatchObject(window);
    expect(offerFilters[0]).toMatchObject(window);
    expect(revisionFilters[0]).toMatchObject(window);
    // `total` follows the range; the tab counts `totals` stay the whole queue's.
    expect(result.ok && result.value.total).toBe(2);
    expect(result.ok && result.value.totals).toEqual({
      'product-revision': 5,
      'offer-first-publication': 7,
    });
  });

  it('keeps one kind to its window, and leaves an empty value as no filter', async () => {
    const one = await build().execute(context(), {
      kind: 'product-revision',
      submittedFrom: '2026-11-01T00:00:00Z',
      submittedTo: '',
    });
    expect(one.ok).toBe(true);
    expect(offerFilters).toEqual([]);
    expect(revisionFilters[0]).toEqual({
      submittedFrom: Temporal.Instant.from('2026-11-01T00:00:00Z'),
    });
    const none = await build().execute(context(), { submittedFrom: '', submittedTo: null });
    expect(none.ok).toBe(true);
  });

  it('works on the older cursor read too', async () => {
    const result = await build().execute(context(), {
      limit: 5,
      submittedTo: '2026-11-08T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(offerFilters[0]).toMatchObject({
      submittedTo: Temporal.Instant.from('2026-11-08T00:00:00Z'),
    });
  });

  it.each([
    [{ submittedFrom: '2026-11-01' }, 'submittedFrom', 'format'],
    [{ submittedTo: 'yesterday' }, 'submittedTo', 'format'],
    [{ submittedTo: 12 }, 'submittedTo', 'format'],
    [
      { submittedFrom: '2026-11-02T00:00:00Z', submittedTo: '2026-11-01T00:00:00Z' },
      'submittedTo',
      'range',
    ],
  ])('refuses %j as validation.failed before any read', async (input, path, reason) => {
    expect(await build().execute(context(), input)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: reason }] },
    });
    expect(reads).toBe(0);
  });
});
