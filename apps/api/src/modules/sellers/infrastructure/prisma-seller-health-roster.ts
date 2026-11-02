import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SellerHealthRoster,
  SellerHealthRosterEntry,
} from '../application/ports/seller-health-roster';

/** The most a page may hold: a run walks the Market in small batches. */
export const SELLER_HEALTH_ROSTER_MAX_PAGE = 200;

/**
 * {@link SellerHealthRoster} on `seller_files` and the revision its approved pointer names (the
 * pointer is the authority, data design 3.1; the composite key keeps it inside the seller's own
 * revisions, and a mismatch is a fault of the data, so that seller is left out).
 */
export class PrismaSellerHealthRoster implements SellerHealthRoster {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<readonly SellerHealthRosterEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SELLER_HEALTH_ROSTER_MAX_PAGE) {
      throw new RangeError('seller-health.roster: page size out of range');
    }
    const tx = this.prisma.tx(market);
    const pointers = await tx.sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        approvedRevisionId: { not: null },
        ...(after === null ? {} : { sellerId: { gt: after } }),
      },
      orderBy: { sellerId: 'asc' },
      take: limit,
      select: { sellerId: true, approvedRevisionId: true },
    });
    if (pointers.length === 0) return [];
    const revisions = await tx.sellersBusinessFileRevision.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: pointers.map((row) => row.sellerId) },
        id: {
          in: pointers.flatMap((row) =>
            row.approvedRevisionId === null ? [] : [row.approvedRevisionId],
          ),
        },
      },
      select: { id: true, sellerId: true, operatingTimezone: true },
    });
    const byId = new Map(revisions.map((row) => [row.id, row]));
    return pointers.flatMap((pointer) => {
      const revision = byId.get(pointer.approvedRevisionId ?? '');
      if (revision === undefined || revision.sellerId !== pointer.sellerId) return [];
      return [{ sellerId: pointer.sellerId as Id<'Seller'>, zone: revision.operatingTimezone }];
    });
  }
}
