import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaCertificationWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the certificate review counts (dashboards upgrade, phase 1): the certificates
// of the Market naming a pending submission (seller) or revision (product), each waiting since
// that submission; overdue strictly before the age limit.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 168 });

describe.each(TEST_MARKETS)('certificate review count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { model: string; args: Record<string, unknown> }[];
  let rows: unknown[];
  const delegate = (model: string) => ({
    findMany: (args: Record<string, unknown>) => {
      calls.push({ model, args });
      return Promise.resolve(rows);
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ model, args });
      return Promise.resolve(6);
    },
  });
  const prisma = {
    tx: () => ({
      certificationSellerCertification: delegate('seller'),
      certificationProductCertification: delegate('product'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaCertificationWorkQueueCountReader(prisma);
  const at = (iso: string) => new Date(iso);

  beforeEach(() => {
    calls = [];
  });

  it('counts the seller certificates with a pending submission, by submission', async () => {
    rows = [
      { pendingSubmission: { submittedAt: at('2026-11-10T00:00:00Z') } },
      { pendingSubmission: { submittedAt: new Date(STALE.epochMilliseconds) } },
      { pendingSubmission: { submittedAt: at('2026-11-21T00:00:00Z') } },
    ];
    expect(await reader.sellerCertificates(market, NOW, STALE)).toEqual({
      count: 3,
      // Waiting since exactly the age limit is not overdue.
      overdue: 1,
      oldestAt: Temporal.Instant.from('2026-11-10T00:00:00Z'),
    });
    expect(calls).toEqual([
      {
        model: 'seller',
        args: {
          where: { marketId: market.marketId, pendingSubmissionId: { not: null } },
          select: { pendingSubmission: { select: { submittedAt: true } } },
        },
      },
    ]);
  });

  it('counts the product certificates with a pending revision, by submission', async () => {
    rows = [{ pendingRevision: { submittedAt: at('2026-11-01T00:00:00Z') } }];
    expect(await reader.productCertificates(market, NOW, STALE)).toEqual({
      count: 1,
      overdue: 1,
      oldestAt: Temporal.Instant.from('2026-11-01T00:00:00Z'),
    });
    expect(calls).toEqual([
      {
        model: 'product',
        args: {
          where: { marketId: market.marketId, pendingRevisionId: { not: null } },
          select: { pendingRevision: { select: { submittedAt: true } } },
        },
      },
    ]);
  });

  it('answers no oldest when nothing waits', async () => {
    rows = [];
    expect(await reader.productCertificates(market, NOW, STALE)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });

  it('counts the approved seller certificates whose boundary falls in (now, until]', async () => {
    const until = NOW.add({ hours: 24 * 31 });
    expect(await reader.expiringSellerCertificates(market, NOW, until)).toBe(6);
    expect(calls).toEqual([
      {
        model: 'seller',
        args: {
          where: {
            marketId: market.marketId,
            status: 'approved',
            approvedBoundaryAt: {
              gt: new Date(NOW.epochMilliseconds),
              lte: new Date(until.epochMilliseconds),
            },
          },
        },
      },
    ]);
  });
});
