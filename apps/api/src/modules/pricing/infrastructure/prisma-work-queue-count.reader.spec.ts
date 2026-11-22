import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaPricingWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the price-hold count (dashboards upgrade, phase 1): the regular and the
// special records pending review are both counted, overdue strictly before the age limit on
// `submitted_at`, the oldest the earlier of the two; only counts and times are selected.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });

describe.each(TEST_MARKETS)('price-hold count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { model: string; op: string; args: Record<string, unknown> }[];
  let answers: Record<string, { count: number; overdue: number; min: Date | null }>;
  const delegate = (model: string) => ({
    aggregate: (args: Record<string, unknown>) => {
      calls.push({ model, op: 'aggregate', args });
      const a = answers[model]!;
      return Promise.resolve({ _count: { _all: a.count }, _min: { submittedAt: a.min } });
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ model, op: 'count', args });
      return Promise.resolve(answers[model]!.overdue);
    },
  });
  const prisma = {
    tx: () => ({
      pricingRegularPriceRecord: delegate('regular'),
      pricingSpecialPriceRecord: delegate('special'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaPricingWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
  });

  it('adds the regular and the special holds, the oldest the earlier of the two', async () => {
    answers = {
      regular: { count: 2, overdue: 1, min: new Date('2026-11-19T00:00:00Z') },
      special: { count: 3, overdue: 2, min: new Date('2026-11-18T00:00:00Z') },
    };
    expect(await reader.priceHolds(market, NOW, STALE)).toEqual({
      count: 5,
      overdue: 3,
      oldestAt: Temporal.Instant.from('2026-11-18T00:00:00Z'),
    });
    const where = { marketId: market.marketId, status: 'pending-review' };
    const stale = { where: { ...where, submittedAt: { lt: new Date(STALE.epochMilliseconds) } } };
    const aggregate = { where, _count: { _all: true }, _min: { submittedAt: true } };
    expect(calls).toEqual([
      { model: 'regular', op: 'aggregate', args: aggregate },
      { model: 'special', op: 'aggregate', args: aggregate },
      { model: 'regular', op: 'count', args: stale },
      { model: 'special', op: 'count', args: stale },
    ]);
  });

  it('answers no oldest when nothing is held', async () => {
    answers = {
      regular: { count: 0, overdue: 0, min: null },
      special: { count: 0, overdue: 0, min: null },
    };
    expect(await reader.priceHolds(market, NOW, STALE)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });
});
