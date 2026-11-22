import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { PrismaCatalogWorkQueueCountReader } from './prisma-work-queue-count.reader';

// The statements of the catalog work-queue counts (dashboards upgrade, phase 1): each count's
// where clause is its list's (status, scope, Market), overdue is strictly before the age limit on
// the column the list sorts by, and the answer is built from the aggregate. The database spec runs
// the same statements against PostgreSQL.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const OLDEST = new Date('2026-11-18T00:00:00Z');

describe.each(TEST_MARKETS)('catalog work-queue count statements in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let calls: { model: string; op: string; args: Record<string, unknown> }[];
  let min: Record<string, Date | null>;
  let total: number;
  let overdueCount: number;
  const delegate = (model: string) => ({
    aggregate: (args: Record<string, unknown>) => {
      calls.push({ model, op: 'aggregate', args });
      return Promise.resolve({ _count: { _all: total }, _min: min });
    },
    count: (args: Record<string, unknown>) => {
      calls.push({ model, op: 'count', args });
      return Promise.resolve(overdueCount);
    },
    groupBy: (args: Record<string, unknown>) => {
      calls.push({ model, op: 'groupBy', args });
      return Promise.resolve([
        { groupKey: 'a', _min: { detectedAt: OLDEST } },
        { groupKey: 'b', _min: { detectedAt: new Date('2026-11-21T00:00:00Z') } },
      ]);
    },
  });
  const prisma = {
    tx: () => ({
      catalogOffer: delegate('offer'),
      catalogOfferTag: delegate('tag'),
      catalogProduct: delegate('product'),
      catalogBrandMergeCandidate: delegate('brandMerge'),
      catalogCategoryProposal: delegate('proposal'),
    }),
  } as unknown as PrismaService;
  const reader = new PrismaCatalogWorkQueueCountReader(prisma);

  beforeEach(() => {
    calls = [];
    total = 3;
    overdueCount = 1;
  });

  it('counts the active tags of every type past their validity end, each one overdue', async () => {
    min = { validUntil: OLDEST };
    expect(await reader.claimsWithoutCertificate(market, NOW)).toEqual({
      count: 3,
      overdue: 3,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    expect(calls).toEqual([
      {
        model: 'tag',
        op: 'aggregate',
        args: {
          where: {
            marketId: market.marketId,
            status: 'active',
            validUntil: { lt: new Date(NOW.epochMilliseconds) },
          },
          _count: { _all: true },
          _min: { validUntil: true },
        },
      },
    ]);
  });

  it('counts the Offers pending first publication, by submission', async () => {
    min = { submittedAt: OLDEST };
    expect(await reader.pendingOffers(market, NOW, STALE)).toEqual({
      count: 3,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    const where = { marketId: market.marketId, status: 'pending-first-publish' };
    expect(calls).toEqual([
      {
        model: 'offer',
        op: 'aggregate',
        args: { where, _count: { _all: true }, _min: { submittedAt: true } },
      },
      {
        model: 'offer',
        op: 'count',
        args: { where: { ...where, submittedAt: { lt: new Date(STALE.epochMilliseconds) } } },
      },
    ]);
  });

  it("counts the sellers' pending revisions only (scope SELLER), by pending submission", async () => {
    min = { pendingSubmittedAt: OLDEST };
    await reader.pendingRevisions(market, NOW, STALE);
    const where = { marketId: market.marketId, scope: 'SELLER', pendingRevisionId: { not: null } };
    expect(calls.map((c) => c.args)).toEqual([
      { where, _count: { _all: true }, _min: { pendingSubmittedAt: true } },
      { where: { ...where, pendingSubmittedAt: { lt: new Date(STALE.epochMilliseconds) } } },
    ]);
  });

  it('counts the pending category proposals of the Market, by creation', async () => {
    min = { createdAt: OLDEST };
    await reader.categoryProposals(market, NOW, STALE);
    const where = { marketId: market.marketId, status: 'pending' };
    expect(calls.map((c) => c.args)).toEqual([
      { where, _count: { _all: true }, _min: { createdAt: true } },
      { where: { ...where, createdAt: { lt: new Date(STALE.epochMilliseconds) } } },
    ]);
  });

  it('counts the open brand merge groups (not brands), overdue by their first detection', async () => {
    expect(await reader.brandMerges(market, NOW, STALE)).toEqual({
      count: 2,
      overdue: 1,
      oldestAt: Temporal.Instant.from(OLDEST.toISOString()),
    });
    expect(calls).toEqual([
      {
        model: 'brandMerge',
        op: 'groupBy',
        args: { by: ['groupKey'], where: { status: 'open' }, _min: { detectedAt: true } },
      },
    ]);
  });

  it('answers no oldest for an empty queue', async () => {
    total = 0;
    overdueCount = 0;
    min = { submittedAt: null };
    expect(await reader.pendingOffers(market, NOW, STALE)).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });
});
