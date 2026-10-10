import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AdminFlagCode,
  AdminFlagRepository,
} from '../application/ports/admin-flag.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link AdminFlagRepository} on `sellers.admin_flags` (data design 3.13). Raising is one insert
 * that does nothing on a conflict with the partial unique "one open flag per Market, seller and
 * code", so a flag already open leaves the unit usable.
 */
export class PrismaAdminFlagRepository implements AdminFlagRepository {
  constructor(private readonly prisma: PrismaService) {}

  async raise(
    market: MarketContext,
    flag: {
      readonly id: Id;
      readonly sellerId: Id<'Seller'>;
      readonly code: AdminFlagCode;
      readonly now: Temporal.Instant;
    },
  ): Promise<'raised' | 'already-open'> {
    const { count } = await this.prisma.tx(market).sellersAdminFlag.createMany({
      data: [
        {
          id: flag.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: flag.sellerId,
          code: flag.code,
          raisedAt: toDate(flag.now),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? 'raised' : 'already-open';
  }
}
