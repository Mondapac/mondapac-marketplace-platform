import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { SELLER_LIST_HEALTH_DAYS } from '../application/use-cases/list.use-case';
import { PrismaSellersWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the sellers work-queue counts (dashboards upgrade, phase 1): the applications
// are the business-file revisions pending in the Market, overdue strictly before the age limit on
// `created_at` (the tab's order); the health queue is the store's `unhealthy` read over the
// queue's own days.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const OLDEST = new Date('2026-11-18T00:00:00Z');

describe.each(TEST_MARKETS)('sellers work-queue count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { op: string; args: Record<string, unknown> }[];
  const prisma = {
    tx: () => ({
      sellersBusinessFileRevision: {
        aggregate: (args: Record<string, unknown>) => {
          calls.push({ op: 'aggregate', args });
          return Promise.resolve({ _count: { _all: 2 }, _min: { createdAt: OLDEST } });
        },
        count: (args: Record<string, unknown>) => {
          calls.push({ op: 'count', args });
          return Promise.resolve(1);
        },
      },
    }),
  } as unknown as PrismaService;
  let window: Temporal.PlainDate[];
  const healthStore = {
    unhealthy: (_m: unknown, from: Temporal.PlainDate, to: Temporal.PlainDate) => {
      window = [from, to];
      return Promise.resolve({ sellers: [{}, {}, {}] as never[], truncated: false });
    },
  };
  const reader = new PrismaSellersWorkQueueCountReader(prisma, healthStore);

  beforeEach(() => {
    calls = [];
  });

  it('counts the pending seller files of the Market, by creation', async () => {
    expect(await reader.applications(market, NOW, STALE)).toEqual({
      count: 2,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = { marketId: market.marketId, status: 'pending' };
    expect(calls).toEqual([
      { op: 'aggregate', args: { where, _count: { _all: true }, _min: { createdAt: true } } },
      {
        op: 'count',
        args: { where: { ...where, createdAt: { lt: new Date(STALE.epochMilliseconds) } } },
      },
    ]);
  });

  it("counts the health queue over the list's days, a snapshot with no overdue", async () => {
    expect(await reader.unhealthySellers(market, NOW)).toEqual({
      count: 3,
      overdue: 0,
      oldestAt: null,
    });
    const today = Temporal.PlainDate.from('2026-11-22');
    expect(window).toEqual([
      today.subtract({ days: SELLER_LIST_HEALTH_DAYS - 1 }),
      today.add({ days: 1 }),
    ]);
  });
});
