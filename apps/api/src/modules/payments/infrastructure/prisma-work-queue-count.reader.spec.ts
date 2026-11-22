import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaPaymentsWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the payments counts (dashboards upgrade, phase 1; product owner's definitions
// of 22 Nov 2026): the Stripe events stuck since before the age limit or given up within 7 days
// (never `rejected`), and the connected accounts Stripe restricted, in the caller's Market.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 1 });
const OLDEST = new Date('2026-11-21T20:00:00Z');
const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

describe.each(TEST_MARKETS)('payments count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { table: string; op: string; args: Record<string, unknown> }[];
  let total: number;
  const table = (name: string, oldestField: string) => ({
    aggregate: (args: Record<string, unknown>) => {
      calls.push({ table: name, op: 'aggregate', args });
      return Promise.resolve({
        _count: { _all: total },
        _min: { [oldestField]: total === 0 ? null : OLDEST },
      });
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ table: name, op: 'count', args });
      return Promise.resolve(total === 0 ? 0 : 1);
    },
  });
  const prisma = {
    tx: () => ({
      paymentsStripeEvent: table('events', 'receivedAt'),
      paymentsConnectedAccount: table('accounts', 'updatedAt'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaPaymentsWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
    total = 2;
  });

  it('counts the events stuck since before the age limit or given up within 7 days', async () => {
    expect(await reader.failedWebhooks(market, NOW, STALE)).toEqual({
      count: 2,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = {
      marketId: market.marketId,
      OR: [
        { processedAt: null, receivedAt: { lt: date(STALE) } },
        { outcome: 'failed', receivedAt: { gte: date(NOW.subtract({ hours: 7 * 24 })) } },
      ],
    };
    expect(calls).toEqual([
      {
        table: 'events',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { receivedAt: true } },
      },
      {
        table: 'events',
        op: 'count',
        args: { where: { ...where, receivedAt: { lt: date(STALE) } } },
      },
    ]);
  });

  it('counts the restricted accounts, overdue by their last update', async () => {
    expect(await reader.restrictedAccounts(market, NOW, STALE)).toEqual({
      count: 2,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = { marketId: market.marketId, status: 'restricted' };
    expect(calls).toEqual([
      {
        table: 'accounts',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { updatedAt: true } },
      },
      {
        table: 'accounts',
        op: 'count',
        args: { where: { ...where, updatedAt: { lt: date(STALE) } } },
      },
    ]);
  });

  it('answers no oldest when a queue is empty', async () => {
    total = 0;
    const empty = { count: 0, overdue: 0, oldestAt: null };
    expect(await reader.failedWebhooks(market, NOW, STALE)).toEqual(empty);
    expect(await reader.restrictedAccounts(market, NOW, STALE)).toEqual(empty);
  });
});
