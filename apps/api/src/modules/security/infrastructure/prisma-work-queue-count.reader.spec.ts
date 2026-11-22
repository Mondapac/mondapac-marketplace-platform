import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaSecurityWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the live-alert count (dashboards upgrade, phase 1): the alerts open or
// acknowledged in the Market, overdue strictly before the age limit on `opened_at`.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 1 });
const OLDEST = new Date('2026-11-21T20:00:00Z');

describe.each(TEST_MARKETS)('live-alert count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { op: string; args: Record<string, unknown> }[];
  let total: number;
  const prisma = {
    tx: () => ({
      securityAlert: {
        aggregate: (args: Record<string, unknown>) => {
          calls.push({ op: 'aggregate', args });
          return Promise.resolve({
            _count: { _all: total },
            _min: { openedAt: total === 0 ? null : OLDEST },
          });
        },
        count: (args: Record<string, unknown>) => {
          calls.push({ op: 'count', args });
          return Promise.resolve(total === 0 ? 0 : 1);
        },
      },
    }),
  } as unknown as PrismaService;
  const reader = new PrismaSecurityWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
    total = 2;
  });

  it('counts the open and acknowledged alerts, by opening', async () => {
    expect(await reader.openAlerts(market, NOW, STALE)).toEqual({
      count: 2,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = { marketId: market.marketId, state: { in: ['open', 'acknowledged'] } };
    expect(calls).toEqual([
      { op: 'aggregate', args: { where, _count: { _all: true }, _min: { openedAt: true } } },
      {
        op: 'count',
        args: { where: { ...where, openedAt: { lt: new Date(STALE.epochMilliseconds) } } },
      },
    ]);
  });

  it('answers no oldest when no alert is live', async () => {
    total = 0;
    expect(await reader.openAlerts(market, NOW, STALE)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });
});
