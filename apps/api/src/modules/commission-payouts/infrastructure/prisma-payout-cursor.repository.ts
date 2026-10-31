import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CursorUpdate,
  PayoutCursor,
  PayoutCursorRepository,
} from '../application/ports/payout-cursor.repository';
import { isBlockReason } from '../domain/payout';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

interface CursorRow {
  readonly sellerId: string;
  readonly lastSlotAt: Date;
  readonly nextSlotAt: Date | null;
  readonly zone: string | null;
  readonly blockReason: string | null;
  readonly evaluatedAt: Date | null;
  readonly updatedAt: Date;
  readonly version: number;
}

const toCursor = (row: CursorRow): PayoutCursor => ({
  sellerId: row.sellerId as Id<'Seller'>,
  lastSlotAt: toInstant(row.lastSlotAt),
  nextSlotAt: orNull(row.nextSlotAt),
  zone: row.zone,
  blockReason: isBlockReason(row.blockReason) ? row.blockReason : null,
  evaluatedAt: orNull(row.evaluatedAt),
  updatedAt: toInstant(row.updatedAt),
  version: row.version,
});

/**
 * {@link PayoutCursorRepository} on `commission_payouts.payout_schedule_cursors`, scoped by
 * `marketId` in every `where`. The row lock is a version bump (an UPDATE takes the row lock until
 * the unit ends), so no raw SQL is needed.
 */
export class PrismaPayoutCursorRepository implements PayoutCursorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ensure(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    await this.prisma.tx(market).commissionPayoutsPayoutScheduleCursor.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          lastSlotAt: toDate(now),
          updatedAt: toDate(now),
          version: 1,
        },
      ],
      skipDuplicates: true,
    });
  }

  async lock(market: MarketContext, sellerId: Id<'Seller'>) {
    const tx = this.prisma.tx(market);
    const locked = await tx.commissionPayoutsPayoutScheduleCursor.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { version: { increment: 1 } },
    });
    if (locked.count === 0) return null;
    const row = await tx.commissionPayoutsPayoutScheduleCursor.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : toCursor(row);
  }

  async find(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).commissionPayoutsPayoutScheduleCursor.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : toCursor(row);
  }

  async save(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    update: CursorUpdate,
    now: Temporal.Instant,
  ) {
    await this.prisma.tx(market).commissionPayoutsPayoutScheduleCursor.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: {
        lastSlotAt: toDate(update.lastSlotAt),
        nextSlotAt: update.nextSlotAt === null ? null : toDate(update.nextSlotAt),
        zone: update.zone,
        blockReason: update.blockReason,
        evaluatedAt: toDate(update.evaluatedAt),
        updatedAt: toDate(now),
      },
    });
  }

  async listDue(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
    limit: number,
  ) {
    const rows = await this.prisma.tx(market).commissionPayoutsPayoutScheduleCursor.findMany({
      where: {
        marketId: market.marketId,
        OR: [
          { nextSlotAt: { lte: toDate(now) } },
          {
            nextSlotAt: null,
            OR: [{ evaluatedAt: null }, { evaluatedAt: { lt: toDate(staleBefore) } }],
          },
        ],
      },
      orderBy: [{ nextSlotAt: { sort: 'asc', nulls: 'first' } }, { sellerId: 'asc' }],
      take: limit,
    });
    return rows.map(toCursor);
  }

  async invalidate(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    await this.prisma.tx(market).commissionPayoutsPayoutScheduleCursor.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: {
        nextSlotAt: null,
        evaluatedAt: null,
        updatedAt: toDate(now),
        version: { increment: 1 },
      },
    });
  }
}
