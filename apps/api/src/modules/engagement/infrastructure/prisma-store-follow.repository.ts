import type { Prisma } from '../../../generated/prisma/client';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { MAX_FOLLOWS_PER_ACCOUNT, type StoreFollow } from '../domain/store-follow';
import type {
  StoreFollowCursor,
  StoreFollowRepository,
} from '../application/ports/store-follow.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface Row {
  readonly id: string;
  readonly accountId: string;
  readonly sellerId: string;
  readonly followedAt: Date;
}

const toFollow = (row: Row): StoreFollow => ({
  id: row.id as Id<'StoreFollow'>,
  accountId: row.accountId as Id<'Account'>,
  sellerId: row.sellerId as Id<'Seller'>,
  followedAt: Temporal.Instant.fromEpochMilliseconds(row.followedAt.getTime()),
});

const SELECT = { id: true, accountId: true, sellerId: true, followedAt: true } as const;

/**
 * {@link StoreFollowRepository} on `engagement.store_follows`, scoped by `marketId` and the
 * account in every `where`.
 */
export class PrismaStoreFollowRepository implements StoreFollowRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, accountId: Id<'Account'>, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).engagementStoreFollow.findFirst({
      where: { marketId: market.marketId, accountId, sellerId },
      select: SELECT,
    });
    return row === null ? null : toFollow(row);
  }

  async insert(market: MarketContext, follow: StoreFollow): Promise<'inserted' | 'exists'> {
    const { count } = await this.prisma.tx(market).engagementStoreFollow.createMany({
      data: [
        {
          id: follow.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: follow.accountId,
          sellerId: follow.sellerId,
          followedAt: toDate(follow.followedAt),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? 'inserted' : 'exists';
  }

  async remove(market: MarketContext, accountId: Id<'Account'>, id: Id<'StoreFollow'>) {
    const { count } = await this.prisma.tx(market).engagementStoreFollow.deleteMany({
      where: { marketId: market.marketId, accountId, id },
    });
    return count > 0;
  }

  countOf(market: MarketContext, accountId: Id<'Account'>) {
    return this.prisma.tx(market).engagementStoreFollow.count({
      where: { marketId: market.marketId, accountId },
    });
  }

  async pageOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: StoreFollowCursor | null,
    limit: number,
  ) {
    const before: Prisma.EngagementStoreFollowWhereInput =
      after === null
        ? {}
        : {
            OR: [
              { followedAt: { lt: toDate(after.followedAt) } },
              { followedAt: toDate(after.followedAt), id: { lt: after.id } },
            ],
          };
    const rows = await this.prisma.tx(market).engagementStoreFollow.findMany({
      where: { marketId: market.marketId, accountId, ...before },
      orderBy: [{ followedAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
      take: limit,
    });
    return rows.map(toFollow);
  }

  async followedAmong(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ) {
    if (sellerIds.length === 0) return [];
    const rows = await this.prisma.tx(market).engagementStoreFollow.findMany({
      where: { marketId: market.marketId, accountId, sellerId: { in: [...sellerIds] } },
      select: SELECT,
    });
    return rows.map(toFollow);
  }

  async allOf(market: MarketContext, accountId: Id<'Account'>) {
    const rows = await this.prisma.tx(market).engagementStoreFollow.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ followedAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
      take: MAX_FOLLOWS_PER_ACCOUNT,
    });
    return rows.map(toFollow);
  }

  async deleteForAccount(market: MarketContext, accountId: Id<'Account'>) {
    const { count } = await this.prisma.tx(market).engagementStoreFollow.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return count;
  }
}
