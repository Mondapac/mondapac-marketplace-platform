import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaPaymentsWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statement of the payments seller task (dashboards upgrade, phase 1, PR 6): the session
// seller's own account row in the caller's Market, when restricted or not paying out.

const parsed = parseId<'Seller'>('01990000-0000-7000-8000-0000000000a3');
if (!parsed.ok) throw new Error('bad id');
const SELLER: Id<'Seller'> = parsed.value;
const UPDATED = new Date('2026-11-21T20:00:00Z');

describe.each(TEST_MARKETS)('payments seller task statement in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: Record<string, unknown>[];
  let row: { updatedAt: Date } | null;
  const prisma = {
    tx: () => ({
      paymentsConnectedAccount: {
        findFirst: (args: Record<string, unknown>) => {
          calls.push(args);
          return Promise.resolve(row);
        },
      },
    }),
  } as unknown as PrismaService;
  const reader = new PrismaPaymentsWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
    row = { updatedAt: UPDATED };
  });

  it("reads the seller's own account, restricted or not paying out", async () => {
    expect(await reader.sellerPayoutsBlocked(market, SELLER)).toEqual({
      count: 1,
      overdue: 0,
      oldestAt: Temporal.Instant.from(UPDATED.toISOString()),
    });
    expect(calls).toEqual([
      {
        where: {
          marketId: market.marketId,
          sellerId: SELLER,
          OR: [{ status: 'restricted' }, { payoutsEnabled: false }],
        },
        select: { updatedAt: true },
      },
    ]);
  });

  it('answers 0 when the account pays out or there is none', async () => {
    row = null;
    expect(await reader.sellerPayoutsBlocked(market, SELLER)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });
});
