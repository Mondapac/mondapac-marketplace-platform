import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  SellerReviewCredit,
  SellerReviewStandingRepository,
} from '../application/ports/seller-review-standing.repository';
import {
  SellerReviewStanding,
  type SellerReviewStandingState,
  type StandingTargetKind,
} from '../domain/seller-review-standing';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const COLUMNS = {
  marketId: true,
  sellerId: true,
  epoch: true,
  targetKind: true,
  consecutiveChangesNeeded: true,
  trustedAt: true,
  trustLostAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface Row {
  readonly marketId: string;
  readonly sellerId: string;
  readonly epoch: number;
  readonly targetKind: string;
  readonly consecutiveChangesNeeded: number;
  readonly trustedAt: Date | null;
  readonly trustLostAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function stateOf(row: Row): SellerReviewStandingState {
  return {
    marketId: row.marketId as MarketId,
    sellerId: row.sellerId as Id<'Seller'>,
    epoch: row.epoch,
    targetKind: row.targetKind as StandingTargetKind,
    consecutiveChangesNeeded: row.consecutiveChangesNeeded === 1 ? 1 : 0,
    trustedAt: row.trustedAt === null ? null : toInstant(row.trustedAt),
    trustLostAt: row.trustLostAt === null ? null : toInstant(row.trustLostAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
  };
}

/**
 * {@link SellerReviewStandingRepository} over Prisma, in the caller's unit, every statement scoped
 * by `market_id`. The lock is the guarded client's: an UPDATE that raises the version by one holds
 * the row until the unit ends (no raw SQL); the guard trigger refuses any other version step, a
 * DELETE and an epoch jump. The count is index-only on the credits' key prefix.
 */
export class PrismaSellerReviewStandingRepository implements SellerReviewStandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    now: Temporal.Instant,
  ): Promise<SellerReviewStanding> {
    const table = this.prisma.tx(market).catalogSellerReviewStanding;
    const start = SellerReviewStanding.start({
      marketId: market.marketId,
      sellerId,
      now,
    }).state;
    // Created lazily: `ON CONFLICT (market_id, seller_id) DO NOTHING`.
    await table.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          epoch: start.epoch,
          targetKind: start.targetKind,
          consecutiveChangesNeeded: start.consecutiveChangesNeeded,
          trustedAt: null,
          trustLostAt: null,
          version: start.version,
          createdAt: toDate(now),
          updatedAt: toDate(now),
        },
      ],
      skipDuplicates: true,
    });
    const { count } = await table.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { version: { increment: 1 }, updatedAt: toDate(now) },
    });
    if (count !== 1) throw new StaleAggregateError('seller-review-standing', sellerId);
    const row = await table.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: COLUMNS,
    });
    if (row === null) throw new StaleAggregateError('seller-review-standing', sellerId);
    return SellerReviewStanding.restore(stateOf(row));
  }

  async save(market: MarketContext, standing: SellerReviewStanding): Promise<void> {
    const state = standing.state;
    if (state.marketId !== market.marketId) throw new Error('save: another Market');
    const { count } = await this.prisma.tx(market).catalogSellerReviewStanding.updateMany({
      where: { marketId: market.marketId, sellerId: state.sellerId, version: state.version },
      data: {
        epoch: state.epoch,
        targetKind: state.targetKind,
        consecutiveChangesNeeded: state.consecutiveChangesNeeded,
        trustedAt: state.trustedAt === null ? null : toDate(state.trustedAt),
        trustLostAt: state.trustLostAt === null ? null : toDate(state.trustLostAt),
        updatedAt: toDate(state.updatedAt),
        version: state.version + 1,
      },
    });
    if (count !== 1) throw new StaleAggregateError('seller-review-standing', state.sellerId);
  }

  async credit(market: MarketContext, credit: SellerReviewCredit): Promise<boolean> {
    // Once per product per epoch: `ON CONFLICT DO NOTHING` on the primary key.
    const { count } = await this.prisma.tx(market).catalogSellerReviewCredit.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: credit.sellerId,
          epoch: credit.epoch,
          productId: credit.productId,
          offerId: credit.offerId,
          creditedAt: toDate(credit.creditedAt),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  count(market: MarketContext, sellerId: Id<'Seller'>, epoch: number): Promise<number> {
    return this.prisma.tx(market).catalogSellerReviewCredit.count({
      where: { marketId: market.marketId, sellerId, epoch },
    });
  }

  async read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<{ readonly state: SellerReviewStandingState; readonly count: number } | null> {
    const row = await this.prisma.tx(market).catalogSellerReviewStanding.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: COLUMNS,
    });
    if (row === null) return null;
    const count = await this.count(market, sellerId, row.epoch);
    return { state: stateOf(row), count };
  }
}
