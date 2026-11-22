import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { CatalogWorkQueueCountReader } from '../application/ports/work-queue-count.reader';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** A queue's answer from its count, its overdue count and its earliest entry time. */
function answer(count: number, overdue: number, oldest: Date | null): WorkQueueCount {
  return {
    count,
    overdue,
    oldestAt:
      count === 0 || oldest === null
        ? null
        : Temporal.Instant.fromEpochMilliseconds(oldest.getTime()),
  };
}

/**
 * {@link CatalogWorkQueueCountReader} over Prisma. Each queue is one aggregate (count and earliest
 * entry) and one overdue count on the same partial index the queue's own list reads: the Offers
 * pending first publication on (market_id, submitted_at, id), the products with a pending revision
 * on (market_id, pending_submitted_at, id), the pending category proposals on (market_id,
 * created_at, id). The brand merge queue is shared by every Market (brands are platform-wide): its
 * open groups are grouped by key on (status, group_key), as the queue's list reads them (the list
 * pages them; the count takes every open group).
 *
 * On the CAT-52 shelf-isolation allow-list for its count of `catalog.category_proposals` only (a
 * count and the earliest `created_at`): any other shelf identifier here needs a security review.
 */
export class PrismaCatalogWorkQueueCountReader implements CatalogWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async pendingOffers(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const offers = this.prisma.tx(market).catalogOffer;
    const where = { marketId: market.marketId, status: 'pending-first-publish' };
    const [all, overdue] = await Promise.all([
      offers.aggregate({ where, _count: { _all: true }, _min: { submittedAt: true } }),
      offers.count({ where: { ...where, submittedAt: { lt: toDate(staleBefore) } } }),
    ]);
    return answer(all._count._all, overdue, all._min.submittedAt);
  }

  async pendingRevisions(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const products = this.prisma.tx(market).catalogProduct;
    // The review queue's revisions: seller-scoped products with a pending revision (the
    // reader's pendingRevisionsWhere without its list filters).
    const where = {
      marketId: market.marketId,
      scope: 'SELLER',
      pendingRevisionId: { not: null },
    } as const;
    const [all, overdue] = await Promise.all([
      products.aggregate({ where, _count: { _all: true }, _min: { pendingSubmittedAt: true } }),
      products.count({ where: { ...where, pendingSubmittedAt: { lt: toDate(staleBefore) } } }),
    ]);
    return answer(all._count._all, overdue, all._min.pendingSubmittedAt);
  }

  async brandMerges(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    // One row per open group (a few dozen at most: near-duplicate names found by the backfill).
    const groups = await this.prisma.tx(market).catalogBrandMergeCandidate.groupBy({
      by: ['groupKey'],
      where: { status: 'open' },
      _min: { detectedAt: true },
    });
    const firsts = groups.flatMap((group) =>
      group._min.detectedAt === null ? [] : [group._min.detectedAt],
    );
    const oldest = firsts.reduce<Date | null>(
      (first, at) => (first === null || at < first ? at : first),
      null,
    );
    const before = toDate(staleBefore);
    return answer(groups.length, firsts.filter((at) => at < before).length, oldest);
  }

  async categoryProposals(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const proposals = this.prisma.tx(market).catalogCategoryProposal;
    const where = { marketId: market.marketId, status: 'pending' };
    const [all, overdue] = await Promise.all([
      proposals.aggregate({ where, _count: { _all: true }, _min: { createdAt: true } }),
      proposals.count({ where: { ...where, createdAt: { lt: toDate(staleBefore) } } }),
    ]);
    return answer(all._count._all, overdue, all._min.createdAt);
  }
}
