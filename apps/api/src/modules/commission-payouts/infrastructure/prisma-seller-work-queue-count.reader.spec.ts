import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaCommissionPayoutsWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the commission-payouts seller tasks (dashboards upgrade, phase 1, PR 6), held
// to the session's seller and the caller's Market: the disputes of the seller's active dispute
// holds that need a response (overdue past the deadline), and the seller's active holds.

const parsed = parseId<'Seller'>('01990000-0000-7000-8000-0000000000a3');
if (!parsed.ok) throw new Error('bad id');
const SELLER: Id<'Seller'> = parsed.value;
const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const OLDEST = new Date('2026-11-21T20:00:00Z');
const DISPUTES = ['01990000-0000-7000-8000-0000000000d1', '01990000-0000-7000-8000-0000000000d2'];
const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

describe.each(TEST_MARKETS)('commission-payouts seller task statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { table: string; op: string; args: Record<string, unknown> }[];
  let holdRefs: string[];
  const table = (name: string, oldestField: string) => ({
    findMany: (args: Record<string, unknown>) => {
      calls.push({ table: name, op: 'findMany', args });
      return Promise.resolve(holdRefs.map((sourceRef) => ({ sourceRef })));
    },
    aggregate: (args: Record<string, unknown>) => {
      calls.push({ table: name, op: 'aggregate', args });
      return Promise.resolve({ _count: { _all: 2 }, _min: { [oldestField]: OLDEST } });
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ table: name, op: 'count', args });
      return Promise.resolve(1);
    },
  });
  const prisma = {
    tx: () => ({
      commissionPayoutsPayoutHold: table('holds', 'placedAt'),
      commissionPayoutsDisputeCase: table('disputes', 'evidenceDueBy'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaCommissionPayoutsWorkQueueCountReader(prisma);
  const answered = { count: 2, overdue: 1, oldestAt: Temporal.Instant.from(OLDEST.toISOString()) };

  beforeEach(() => {
    calls = [];
    holdRefs = DISPUTES;
  });

  it("counts the cases of the seller's dispute holds that need a response", async () => {
    expect(await reader.sellerDisputesNeedingReply(market, SELLER, NOW)).toEqual(answered);
    const where = {
      marketId: market.marketId,
      disputeId: { in: DISPUTES },
      bucket: 'needs-response',
    };
    expect(calls).toEqual([
      {
        table: 'holds',
        op: 'findMany',
        args: {
          where: {
            marketId: market.marketId,
            sellerId: SELLER,
            releasedAt: null,
            reason: 'dispute',
          },
          select: { sourceRef: true },
          distinct: ['sourceRef'],
        },
      },
      {
        table: 'disputes',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { evidenceDueBy: true } },
      },
      {
        table: 'disputes',
        op: 'count',
        args: { where: { ...where, evidenceDueBy: { lt: date(NOW) } } },
      },
    ]);
  });

  it('reads no case when the seller has no dispute hold', async () => {
    holdRefs = [];
    expect(await reader.sellerDisputesNeedingReply(market, SELLER, NOW)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
    expect(calls.map((c) => c.op)).toEqual(['findMany']);
  });

  it("counts the seller's active holds, overdue by their placement", async () => {
    expect(await reader.sellerPayoutHolds(market, SELLER, STALE)).toEqual(answered);
    const where = { marketId: market.marketId, sellerId: SELLER, releasedAt: null };
    expect(calls).toEqual([
      {
        table: 'holds',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { placedAt: true } },
      },
      { table: 'holds', op: 'count', args: { where: { ...where, placedAt: { lt: date(STALE) } } } },
    ]);
  });
});
