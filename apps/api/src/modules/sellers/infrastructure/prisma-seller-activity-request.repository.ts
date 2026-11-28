import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SellerActivityRequestRepository,
  StoredActivityRequest,
} from '../application/ports/seller-activity-request.repository';
import type { ActivityAssignment } from '../domain/seller-business-activities';

/** {@link SellerActivityRequestRepository} on `sellers.seller_activity_requests`, Market-scoped. */
export class PrismaSellerActivityRequestRepository implements SellerActivityRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoredActivityRequest | null> {
    const row = await this.prisma.tx(market).sellersSellerActivityRequest.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { mainActivityId: true, extraActivityIds: true, requestedAt: true },
    });
    if (row === null) return null;
    return {
      mainActivityId: row.mainActivityId as Id<'BusinessActivity'>,
      extraActivityIds: [...row.extraActivityIds].sort() as Id<'BusinessActivity'>[],
      requestedAt: Temporal.Instant.fromEpochMilliseconds(row.requestedAt.getTime()),
    };
  }

  async save(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    next: ActivityAssignment & { readonly by: Id<'Account'>; readonly at: Temporal.Instant },
  ): Promise<void> {
    const values = {
      mainActivityId: next.mainActivityId,
      extraActivityIds: [...next.extraActivityIds],
      requestedBy: next.by,
      requestedAt: new Date(next.at.epochMilliseconds),
    };
    // The guarded client wants the Market at the top of `where`, so: update, else insert. Two first
    // saves racing end in a unique violation, which the use case answers as unavailable.
    const table = this.prisma.tx(market).sellersSellerActivityRequest;
    const { count } = await table.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: values,
    });
    if (count === 0) {
      await table.create({
        data: { marketId: market.marketId, tenantId: market.tenantId, sellerId, ...values },
        select: { sellerId: true },
      });
    }
  }
}
