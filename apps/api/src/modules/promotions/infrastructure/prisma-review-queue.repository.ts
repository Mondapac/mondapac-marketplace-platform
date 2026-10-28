import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ReviewEntry,
  ReviewQueueRepository,
  ReviewReason,
  ReviewStatus,
} from '../application/ports/review-queue.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly promotionId: string;
  readonly sellerId: string;
  readonly reason: string;
  readonly status: string;
  readonly openedAt: Date;
  readonly decidedAt: Date | null;
}

const toEntry = (row: Row): ReviewEntry => ({
  id: row.id as Id<'PromotionReview'>,
  promotionId: row.promotionId as Id<'Promotion'>,
  sellerId: row.sellerId as Id<'Seller'>,
  reason: row.reason as ReviewReason,
  status: row.status as ReviewStatus,
  openedAt: fromDate(row.openedAt),
  decidedAt: row.decidedAt === null ? null : fromDate(row.decidedAt),
});

/** {@link ReviewQueueRepository} on `promotions.promotion_reviews`, scoped by `marketId`. */
export class PrismaReviewQueueRepository implements ReviewQueueRepository {
  constructor(private readonly prisma: PrismaService) {}

  async open(market: MarketContext, entry: ReviewEntry): Promise<void> {
    const tx = this.prisma.tx(market);
    // A promotion has at most one OPEN entry (a partial unique index): the seller changing it
    // again moves that entry to the new reason and time instead of being dropped.
    const moved = await tx.promotionsReview.updateMany({
      where: { marketId: market.marketId, promotionId: entry.promotionId, status: 'OPEN' },
      data: { reason: entry.reason, openedAt: toDate(entry.openedAt) },
    });
    if (moved.count > 0) return;
    await tx.promotionsReview.createMany({
      data: [
        {
          id: entry.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          promotionId: entry.promotionId,
          sellerId: entry.sellerId,
          reason: entry.reason,
          status: 'OPEN',
          openedAt: toDate(entry.openedAt),
        },
      ],
    });
  }

  async find(market: MarketContext, id: Id<'PromotionReview'>): Promise<ReviewEntry | null> {
    const row = await this.prisma
      .tx(market)
      .promotionsReview.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toEntry(row);
  }

  async listOpen(market: MarketContext, limit: number): Promise<readonly ReviewEntry[]> {
    const rows = await this.prisma.tx(market).promotionsReview.findMany({
      where: { marketId: market.marketId, status: 'OPEN' },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toEntry);
  }

  async decide(
    market: MarketContext,
    id: Id<'PromotionReview'>,
    status: 'APPROVED' | 'REJECTED',
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void> {
    await this.prisma.tx(market).promotionsReview.updateMany({
      where: { marketId: market.marketId, id, status: 'OPEN' },
      data: { status, decidedAt: toDate(at), decidedByAccountId: by },
    });
  }
}
