import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  EligibilityAnchor,
  EligibilityAnchorRepository,
} from '../application/ports/eligibility-anchor.repository';
import type { AnchorSource } from '../domain/payout-terms';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link EligibilityAnchorRepository} on `commission_payouts.eligibility_anchors`, scoped by
 * `marketId` in every `where`. It only reads and inserts; the table refuses anything else.
 */
export class PrismaEligibilityAnchorRepository implements EligibilityAnchorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertIfAbsent(market: MarketContext, anchor: EligibilityAnchor): Promise<boolean> {
    const created = await this.prisma.tx(market).commissionPayoutsEligibilityAnchor.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerOrderId: anchor.sellerOrderId,
          sellerId: anchor.sellerId,
          orderId: anchor.orderId,
          deliveredAt: toDate(anchor.deliveredAt),
          anchorSource: anchor.source,
          holdDaysApplied: anchor.holdDaysApplied,
          eligibleAt: toDate(anchor.eligibleAt),
          recordedAt: toDate(anchor.recordedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async find(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const row = await this.prisma.tx(market).commissionPayoutsEligibilityAnchor.findFirst({
      where: { marketId: market.marketId, sellerOrderId },
    });
    if (row === null) return null;
    return {
      sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
      orderId: row.orderId as Id<'Order'>,
      sellerId: row.sellerId as Id<'Seller'>,
      deliveredAt: toInstant(row.deliveredAt),
      source: row.anchorSource as AnchorSource,
      holdDaysApplied: row.holdDaysApplied,
      eligibleAt: toInstant(row.eligibleAt),
      recordedAt: toInstant(row.recordedAt),
    };
  }
}
