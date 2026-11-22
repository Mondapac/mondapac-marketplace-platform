import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaCommissionPayoutsWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the payout counts (dashboards upgrade, phase 1; product owner's definitions of
// 22 Nov 2026), in the caller's Market: the payouts failed within 7 days, the active holds, and the
// disputes needing a response due within 24 hours (past due included, overdue once past).

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 1 });
const OLDEST = new Date('2026-11-21T20:00:00Z');
const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

describe.each(TEST_MARKETS)('payout count statements in market %s', (code) => {
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
      commissionPayoutsPayout: table('payouts', 'stateChangedAt'),
      commissionPayoutsPayoutHold: table('holds', 'placedAt'),
      commissionPayoutsDisputeCase: table('disputes', 'evidenceDueBy'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaCommissionPayoutsWorkQueueCountReader(prisma);
  const answered = { count: 2, overdue: 1, oldestAt: Temporal.Instant.from(OLDEST.toISOString()) };

  beforeEach(() => {
    calls = [];
    total = 2;
  });

  it('counts the payouts failed within 7 days, overdue before the age limit', async () => {
    expect(await reader.failedPayouts(market, NOW, STALE)).toEqual(answered);
    const since = date(NOW.subtract({ hours: 7 * 24 }));
    const where = { marketId: market.marketId, state: 'failed', stateChangedAt: { gte: since } };
    expect(calls).toEqual([
      {
        table: 'payouts',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { stateChangedAt: true } },
      },
      {
        table: 'payouts',
        op: 'count',
        args: { where: { ...where, stateChangedAt: { gte: since, lt: date(STALE) } } },
      },
    ]);
  });

  it('counts the active holds, overdue by their placing', async () => {
    expect(await reader.payoutHolds(market, NOW, STALE)).toEqual(answered);
    const where = { marketId: market.marketId, releasedAt: null };
    expect(calls).toEqual([
      {
        table: 'holds',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { placedAt: true } },
      },
      { table: 'holds', op: 'count', args: { where: { ...where, placedAt: { lt: date(STALE) } } } },
    ]);
  });

  it('counts the disputes needing a response due within 24 hours, overdue once past due', async () => {
    expect(await reader.disputesDue(market, NOW)).toEqual(answered);
    const where = {
      marketId: market.marketId,
      bucket: 'needs-response',
      evidenceDueBy: { lt: date(NOW.add({ hours: 24 })) },
    };
    expect(calls).toEqual([
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

  it('answers no oldest when a queue is empty', async () => {
    total = 0;
    const empty = { count: 0, overdue: 0, oldestAt: null };
    expect(await reader.failedPayouts(market, NOW, STALE)).toEqual(empty);
    expect(await reader.payoutHolds(market, NOW, STALE)).toEqual(empty);
    expect(await reader.disputesDue(market, NOW)).toEqual(empty);
  });
});
