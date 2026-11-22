import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the ordering seller tasks (dashboards upgrade, phase 1, PR 6): every one is
// held to the session's seller and the caller's Market and tenant; the late rule is the admin one
// with the seller added; the to-ship count stops at the end of the seller's day and never reaches
// a late order; the pickups are the ready ones not collected.

const parsed = parseId<'Seller'>('01990000-0000-7000-8000-0000000000a3');
if (!parsed.ok) throw new Error('bad id');
const SELLER: Id<'Seller'> = parsed.value;
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const DAY_START = Temporal.Instant.from('2026-11-21T11:00:00Z');
const DAY_END = Temporal.Instant.from('2026-11-22T11:00:00Z');
const PAID = new Date('2026-11-22T00:30:00Z');
const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

describe.each(TEST_MARKETS)('ordering seller task statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { op: string; args: Record<string, unknown> }[];
  const orders = {
    groupBy: (args: Record<string, unknown>) => {
      calls.push({ op: 'groupBy', args });
      return Promise.resolve([{ readyPrepMinutes: 30 }]);
    },
    aggregate: (args: Record<string, unknown>) => {
      calls.push({ op: 'aggregate', args });
      return Promise.resolve({
        _count: { _all: 1 },
        _min: { paidAt: PAID, readyAt: PAID, deliveryWindowEnd: PAID },
      });
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ op: 'count', args });
      return Promise.resolve(1);
    },
  };
  const prisma = { tx: () => ({ orderingSellerOrder: orders }) } as unknown as PrismaService;
  const reader = new PrismaWorkQueueCountReader(prisma);
  const own = { marketId: market.marketId, tenantId: market.tenantId, sellerId: SELLER };

  beforeEach(() => {
    calls = [];
  });

  it('counts late orders by the admin rule, for the seller only', async () => {
    const answer = await reader.sellerLateOrders(
      market,
      SELLER,
      NOW,
      STALE,
      new AbortController().signal,
    );
    expect(answer.count).toBe(2);
    const wheres = calls.map((c) => c.args.where as Record<string, unknown>);
    expect(wheres).toHaveLength(5);
    for (const where of wheres) expect(where).toMatchObject(own);
    expect(wheres[0]).toEqual({
      ...own,
      paidAt: { not: null },
      fulfilment: 'to-ship',
      readyAt: null,
      refundedInFull: false,
      deliveryMethod: { not: 'scheduled' },
      readyPrepMinutes: { not: null },
    });
    expect(wheres[1]).toEqual({
      ...own,
      paidAt: { not: null },
      fulfilment: { not: 'delivered' },
      refundedInFull: false,
      deliveryMethod: 'scheduled',
      deliveryWindowEnd: { lt: date(NOW) },
    });
  });

  it("counts the orders due later on the seller's day, never a late one", async () => {
    expect(
      await reader.sellerToShipToday(
        market,
        SELLER,
        NOW,
        DAY_START,
        DAY_END,
        new AbortController().signal,
      ),
    ).toEqual({ count: 2, overdue: 0, oldestAt: Temporal.Instant.from(PAID.toISOString()) });
    const open = {
      ...own,
      paidAt: { not: null },
      fulfilment: 'to-ship',
      readyAt: null,
      refundedInFull: false,
    };
    const notScheduled = {
      ...open,
      deliveryMethod: { not: 'scheduled' },
      readyPrepMinutes: { not: null },
    };
    expect(calls).toEqual([
      { op: 'groupBy', args: { by: ['readyPrepMinutes'], where: notScheduled } },
      {
        op: 'aggregate',
        args: {
          where: {
            ...open,
            deliveryMethod: 'scheduled',
            deliveryWindowStart: { gte: date(DAY_START), lt: date(DAY_END) },
            deliveryWindowEnd: { gte: date(NOW) },
          },
          _count: { _all: true },
          _min: { paidAt: true },
        },
      },
      {
        op: 'aggregate',
        args: {
          where: {
            ...notScheduled,
            readyPrepMinutes: 30,
            paidAt: {
              gte: date(NOW.subtract({ minutes: 30 })),
              lt: date(DAY_END.subtract({ minutes: 30 })),
            },
          },
          _count: { _all: true },
          _min: { paidAt: true },
        },
      },
    ]);
  });

  it('stops before its second round once the dashboard stopped waiting', async () => {
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      reader.sellerToShipToday(market, SELLER, NOW, DAY_START, DAY_END, stopped.signal),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('counts the ready pickups not collected, overdue by their ready time', async () => {
    expect(await reader.sellerPickupsUncollected(market, SELLER, STALE)).toEqual({
      count: 1,
      overdue: 1,
      oldestAt: Temporal.Instant.from(PAID.toISOString()),
    });
    const ready = {
      ...own,
      paidAt: { not: null },
      deliveryMethod: 'pickup',
      fulfilment: 'to-ship',
      readyAt: { not: null },
      refundedInFull: false,
    };
    expect(calls).toEqual([
      {
        op: 'aggregate',
        args: { where: ready, _count: { _all: true }, _min: { readyAt: true } },
      },
      { op: 'count', args: { where: { ...ready, readyAt: { lt: date(STALE) } } } },
    ]);
  });
});
