import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ActivityChangeRecord,
  SellerBusinessActivityRepository,
} from '../application/ports/seller-business-activity.repository';
import type { StoredActivityAssignment } from '../domain/seller-business-activities';

const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link SellerBusinessActivityRepository} on `sellers.seller_business_activities`,
 * `sellers.seller_business_activity_changes` and the seller's `seller_admin_settings` row (the
 * lock), every statement scoped by the Market.
 */
export class PrismaSellerBusinessActivityRepository implements SellerBusinessActivityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    // Raising the version takes the row lock until the unit ends (the guarded client sends no raw
    // SQL), so two replacements of one seller run one after the other.
    const { count } = await this.prisma.tx(market).sellersSellerAdminSettings.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { version: { increment: 1 } },
    });
    return count > 0;
  }

  async find(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, StoredActivityAssignment>> {
    if (sellerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).sellersSellerBusinessActivity.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      select: { sellerId: true, activityId: true, isMain: true },
      orderBy: [{ sellerId: 'asc' }, { activityId: 'asc' }],
    });
    const found = new Map<
      Id<'Seller'>,
      { main: Id<'BusinessActivity'> | null; extras: Id<'BusinessActivity'>[] }
    >();
    for (const row of rows) {
      const sellerId = row.sellerId as Id<'Seller'>;
      const entry = found.get(sellerId) ?? { main: null, extras: [] };
      if (row.isMain) entry.main = row.activityId as Id<'BusinessActivity'>;
      else entry.extras.push(row.activityId as Id<'BusinessActivity'>);
      found.set(sellerId, entry);
    }
    return new Map(
      [...found].map(([sellerId, entry]) => [
        sellerId,
        { mainActivityId: entry.main, extraActivityIds: entry.extras },
      ]),
    );
  }

  async replace(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    next: {
      readonly mainActivityId: Id<'BusinessActivity'>;
      readonly extraActivityIds: readonly Id<'BusinessActivity'>[];
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void> {
    const table = this.prisma.tx(market).sellersSellerBusinessActivity;
    await table.deleteMany({ where: { marketId: market.marketId, sellerId } });
    const base = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      sellerId,
      assignedBy: next.by,
      assignedAt: new Date(next.at.epochMilliseconds),
    };
    await table.createMany({
      data: [
        { ...base, activityId: next.mainActivityId, isMain: true },
        ...next.extraActivityIds.map((activityId) => ({ ...base, activityId, isMain: false })),
      ],
    });
  }

  async appendChange(
    market: MarketContext,
    entry: Parameters<SellerBusinessActivityRepository['appendChange']>[1],
  ): Promise<void> {
    await this.prisma.tx(market).sellersSellerBusinessActivityChange.create({
      data: {
        id: entry.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: entry.sellerId,
        changedBy: entry.by,
        changedAt: new Date(entry.at.epochMilliseconds),
        reason: entry.reason,
        beforeMainId: entry.before.mainActivityId,
        beforeExtraIds: [...entry.before.extraActivityIds],
        afterMainId: entry.after.mainActivityId,
        afterExtraIds: [...entry.after.extraActivityIds],
      },
      select: { id: true },
    });
  }

  async lastChange(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<ActivityChangeRecord | null> {
    const row = await this.prisma.tx(market).sellersSellerBusinessActivityChange.findFirst({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { changedBy: true, changedAt: true, reason: true },
    });
    return row === null
      ? null
      : {
          changedBy: row.changedBy as Id<'Account'>,
          changedAt: instantOf(row.changedAt),
          reason: row.reason,
        };
  }
}
