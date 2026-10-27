import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { ViewBlockStats } from '../../src/modules/engagement/application/use-cases/view-block-stats.use-case';
import { PrismaBlockCountRepository } from '../../src/modules/engagement/infrastructure/prisma-block-count.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The admin read of block counts as the application role, in both Market fixtures: one page's
// rows of the span (both ends included) come back by block and day, read-only; another page's
// and another Market's rows never do.

const T0 = Temporal.Instant.from('2026-10-25T09:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const day = (value: string) => Temporal.PlainDate.from(value);

describe.each(TEST_MARKETS)('block stats in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'block-stats-db-abcd',
  );
  let db: Persistence;
  let counts: PrismaBlockCountRepository;

  beforeAll(() => {
    db = createPersistence();
    counts = new PrismaBlockCountRepository(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const add = async (
    target: MarketContext,
    pageId: Id<'StorefrontPage'>,
    placementId: Id<'StorefrontPlacement'>,
    on: string,
    impressions: number,
    clicks: number,
  ) => {
    const result = await db.unitOfWork.run(target, async () => {
      await counts.increment(target, day(on), T0, [{ pageId, placementId, impressions, clicks }]);
      return ok(null);
    });
    if (!result.ok) throw new Error('unit failed');
  };

  it("reads one page's rows of the span by block and day, never another page or Market", async () => {
    const page = ids.next<'StorefrontPage'>();
    const otherPage = ids.next<'StorefrontPage'>();
    const hero = ids.next<'StorefrontPlacement'>();
    const shelf = ids.next<'StorefrontPlacement'>();
    await add(market, page, hero, '2026-10-01', 3, 0);
    await add(market, page, hero, '2026-10-01', 2, 1);
    await add(market, page, hero, '2026-10-31', 4, 0);
    await add(market, page, shelf, '2026-10-15', 10, 2);
    await add(market, page, shelf, '2026-09-30', 50, 5);
    await add(market, page, shelf, '2026-11-01', 50, 5);
    await add(market, otherPage, hero, '2026-10-10', 70, 7);
    await add(other, page, hero, '2026-10-10', 80, 8);

    const stats = new ViewBlockStats(gate, {
      unitOfWork: db.unitOfWork,
      counts,
      served: { of: () => Promise.resolve(new Set<string>()) },
      clock,
    });
    const result = await stats.execute(admin, {
      query: { page, from: '2026-10-01', to: '2026-10-31' },
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.truncated).toBe(false);
    expect(
      result.value.blocks.map((b) => [
        b.placementId,
        b.impressions,
        b.clicks,
        b.days.map((d) => `${d.day.toString()}:${d.impressions}/${d.clicks}`),
      ]),
    ).toEqual([
      [shelf, 10, 2, ['2026-10-15:10/2']],
      [hero, 9, 1, ['2026-10-01:5/1', '2026-10-31:4/0']],
    ]);
  });
});
