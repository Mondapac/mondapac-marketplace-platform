import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaReviewsWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the reviews seller task (dashboards upgrade, phase 1, PR 6): the session
// seller's published reviews in the caller's Market with no published reply of that seller (the
// seller Reviews list's `unanswered` view), overdue by their publication.

const parsed = parseId<'Seller'>('01990000-0000-7000-8000-0000000000a3');
if (!parsed.ok) throw new Error('bad id');
const SELLER: Id<'Seller'> = parsed.value;
const STALE = Temporal.Instant.from('2026-11-15T01:00:00Z');
const OLDEST = new Date('2026-11-01T20:00:00Z');

describe.each(TEST_MARKETS)('reviews seller task statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { op: string; args: Record<string, unknown> }[];
  let total: number;
  const prisma = {
    tx: () => ({
      reviewsProductReview: {
        aggregate: (args: Record<string, unknown>) => {
          calls.push({ op: 'aggregate', args });
          return Promise.resolve({
            _count: { _all: total },
            _min: { publishedAt: total === 0 ? null : OLDEST },
          });
        },
        count: (args: Record<string, unknown>) => {
          calls.push({ op: 'count', args });
          return Promise.resolve(total === 0 ? 0 : 1);
        },
      },
    }),
  } as unknown as PrismaService;
  const reader = new PrismaReviewsWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
    total = 3;
  });

  it('counts the unanswered published reviews of the seller', async () => {
    expect(await reader.sellerUnanswered(market, SELLER, STALE)).toEqual({
      count: 3,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = {
      marketId: market.marketId,
      sellerId: SELLER,
      status: 'published',
      replies: { none: { sellerId: SELLER, status: 'published' } },
    };
    expect(calls).toEqual([
      { op: 'aggregate', args: { where, _count: { _all: true }, _min: { publishedAt: true } } },
      {
        op: 'count',
        args: { where: { ...where, publishedAt: { lt: new Date(STALE.epochMilliseconds) } } },
      },
    ]);
  });

  it('answers no oldest when nothing waits', async () => {
    total = 0;
    expect(await reader.sellerUnanswered(market, SELLER, STALE)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });
});
