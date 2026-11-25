import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { ReviewsFacade } from '../../reviews';
import { marketReviewsOf, type ReviewWindowCounts } from '../domain/reviews';
import { FacadeReviewSources } from '../infrastructure/facade-review-sources';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import type { ReviewSources } from './ports/review-sources';
import { ViewMarketplaceReviews } from './use-cases/view-marketplace-reviews.use-case';

// The reviews card (dashboards v2, phase 2) on both Market fixtures: always the last 30 Market
// days against the 30 before, worked out in the Market's zone and handed to the reviews module as
// instants; a platform admin only; off while reviews are off; no numbers below five reviews.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true as const }),
});

/** Counts for `n` reviews with the given ratings (histogram of 1 to 5 stars). */
const counts = (histogram: [number, number, number, number, number]): ReviewWindowCounts => ({
  reviews: histogram.reduce((a, n) => a + n, 0),
  starsSum: histogram.reduce((a, n, i) => a + n * (i + 1), 0),
  histogram,
});
const NONE = counts([0, 0, 0, 0, 0]);

describe('marketReviewsOf', () => {
  it('gives no number below five reviews, and keeps the minimum', () => {
    expect(marketReviewsOf(counts([0, 0, 1, 1, 2]), counts([0, 0, 0, 5, 5]))).toEqual({
      status: 'not-enough-data',
      minimum: 5,
    });
    expect(marketReviewsOf(NONE, NONE)).toEqual({ status: 'not-enough-data', minimum: 5 });
  });

  it('counts, averages and shares the period, and compares it with the period before', () => {
    const now = marketReviewsOf(counts([1, 1, 2, 3, 3]), counts([0, 1, 2, 4, 3]));
    expect(now).toEqual({
      status: 'available',
      reviews: 10,
      reviewsChange: { value: 0, direction: 'flat', state: 'ok' },
      // (1 + 2 + 6 + 12 + 15) / 10 = 3.6
      averageTimes100: 360,
      // before: (2 + 6 + 16 + 15) / 10 = 3.9
      averageChangeTimes100: { value: -30, direction: 'down', state: 'ok' },
      histogram: [1, 1, 2, 3, 3],
      // 2 of 10 are 1 or 2 stars: 20.00%, against 1 of 10 before
      lowStarShareBp: 2000,
      lowStarShareChange: { value: 1000, direction: 'up', state: 'ok' },
    });
  });

  it('leaves the changes out while the period before had fewer than five reviews', () => {
    const now = marketReviewsOf(counts([0, 0, 1, 2, 3]), counts([0, 0, 0, 2, 1]));
    expect(now).toMatchObject({
      status: 'available',
      reviews: 6,
      reviewsChange: { state: 'na' },
      averageChangeTimes100: { state: 'na' },
      lowStarShareChange: { state: 'na' },
    });
  });

  it('refuses counts that do not add up instead of showing them', () => {
    const bad = { reviews: 6, starsSum: 20, histogram: [0, 0, 1, 2, 2] } as ReviewWindowCounts;
    expect(() => marketReviewsOf(bad, NONE)).toThrow(RangeError);
  });
});

describe.each(TEST_MARKETS)('the reviews card in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const zone = new RegistryMarketZone(markets);
  const tz = zone.zoneOf(market);
  const person = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: id(0xa1),
        sessionId: id(0x10a1),
        sellerId: population === 'seller' ? id(0x5e11) : null,
      }),
    );
  const startOf = (text: string) =>
    Temporal.PlainDate.from(text).toZonedDateTime({ timeZone: tz }).toInstant();
  // 10:00 on the Market's 25th, so the Market's today is the 25th in its own zone.
  const clock = new FixedClock(startOf('2026-11-25').add({ hours: 10 }));
  let asked: { from: Temporal.Instant; to: Temporal.Instant }[][];
  let answer: ReturnType<ReviewSources['countsOf']>;
  let sources: ReviewSources;
  let view: ViewMarketplaceReviews;

  beforeEach(() => {
    asked = [];
    answer = Promise.resolve(
      ok([counts([1, 1, 2, 3, 3]), counts([0, 1, 2, 4, 3])] as readonly ReviewWindowCounts[]),
    );
    sources = {
      countsOf: (_context, windows) => {
        asked.push([...windows]);
        return answer;
      },
    };
    view = new ViewMarketplaceReviews(gate, { sources, zone, clock });
  });

  it('asks for the last 30 Market days and the 30 before, as instants in the Market zone', async () => {
    const out = await view.execute(person('admin'), {});
    expect(out.ok).toBe(true);
    expect(asked).toEqual([
      [
        // 2026-10-27 through 2026-11-25 (today included), then 2026-09-27 through 2026-10-26.
        { from: startOf('2026-10-27'), to: startOf('2026-11-26') },
        { from: startOf('2026-09-27'), to: startOf('2026-10-27') },
      ],
    ]);
    expect(out.ok && out.value.period).toMatchObject({
      id: '30d',
      current: { from: '2026-10-27', to: '2026-11-25' },
      previous: { from: '2026-09-27', to: '2026-10-26' },
    });
    expect(out.ok && out.value.reviews).toMatchObject({ status: 'available', reviews: 10 });
  });

  it('answers a platform admin only, and never reads for anyone else', async () => {
    for (const population of ['seller', 'customer'] as const) {
      expect(await view.execute(person(population), {})).toEqual(err({ code: 'access.denied' }));
    }
    expect(await view.execute(testCallContext(market, 'anonymous'), {})).toEqual(
      err({ code: 'access.unauthenticated' }),
    );
    expect(asked).toEqual([]);
  });

  it('answers off while reviews are off, and passes a refusal of the owner on', async () => {
    answer = Promise.resolve(err({ code: 'reviews.disabled' }));
    const off = await view.execute(person('admin'), {});
    expect(off.ok && off.value.reviews).toEqual({ status: 'off' });
    answer = Promise.resolve(err({ code: 'access.denied' }));
    expect(await view.execute(person('admin'), {})).toEqual(err({ code: 'access.denied' }));
    answer = Promise.resolve(err({ code: 'reviews.unavailable' }));
    expect(await view.execute(person('admin'), {})).toEqual(err({ code: 'access.unavailable' }));
  });

  it('hands the caller context to the reviews facade unchanged and copies only the counts', async () => {
    const seen: CallContext[] = [];
    const facade = {
      marketReviewCounts: (context: CallContext) => {
        seen.push(context);
        return Promise.resolve(
          ok([{ ...counts([0, 0, 0, 1, 1]), extra: 'ignored' }, { ...NONE }] as never),
        );
      },
    } as unknown as Pick<ReviewsFacade, 'marketReviewCounts'>;
    const context = person('admin');
    const out = await new FacadeReviewSources(facade).countsOf(context, [
      { from: startOf('2026-10-27'), to: startOf('2026-11-26') },
      { from: startOf('2026-09-27'), to: startOf('2026-10-27') },
    ]);
    expect(seen).toEqual([context]);
    expect(out).toEqual(ok([counts([0, 0, 0, 1, 1]), NONE]));
    const refused = await new FacadeReviewSources({
      marketReviewCounts: () => Promise.resolve(err({ code: 'reviews.disabled' })),
    } as never).countsOf(context, []);
    expect(refused).toEqual(err({ code: 'reviews.disabled' }));
  });
});
