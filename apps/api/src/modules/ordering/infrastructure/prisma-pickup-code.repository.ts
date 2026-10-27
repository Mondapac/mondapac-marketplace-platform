import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PickupCodeRepository } from '../application/ports/pickup-code.repository';
import {
  PICKUP_MAX_FAILED_ATTEMPTS,
  pickupStatusOf,
  type PickupCodeRecord,
} from '../domain/pickup-code';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly sellerOrderId: string;
  readonly codeHash: string;
  readonly codeSealed: string;
  readonly failedAttempts: number;
  readonly lockedAt: Date | null;
  readonly issuedAt: Date;
}

const toRecord = (row: Row): PickupCodeRecord => ({
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
  hash: row.codeHash,
  sealed: row.codeSealed,
  failedAttempts: row.failedAttempts,
  lockedAt: row.lockedAt === null ? null : toInstant(row.lockedAt),
  issuedAt: toInstant(row.issuedAt),
});

/**
 * {@link PickupCodeRepository} on `ordering.pickup_codes`, through the Market-scoped client with
 * `marketId` at the top level of every `where`. A wrong code is counted by one conditional
 * increment, so two simultaneous tries can never take the count past the limit.
 */
export class PrismaPickupCodeRepository implements PickupCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const row = await this.prisma.tx(market).orderingPickupCode.findFirst({
      where: { marketId: market.marketId, sellerOrderId },
    });
    return row === null ? null : toRecord(row);
  }

  async findMany(market: MarketContext, sellerOrderIds: readonly Id<'SellerOrder'>[]) {
    const found = new Map<Id<'SellerOrder'>, PickupCodeRecord>();
    if (sellerOrderIds.length === 0) return found;
    const rows = await this.prisma.tx(market).orderingPickupCode.findMany({
      where: { marketId: market.marketId, sellerOrderId: { in: [...sellerOrderIds] } },
    });
    for (const row of rows) found.set(row.sellerOrderId as Id<'SellerOrder'>, toRecord(row));
    return found;
  }

  async insert(market: MarketContext, record: PickupCodeRecord) {
    const created = await this.prisma.tx(market).orderingPickupCode.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerOrderId: record.sellerOrderId,
          codeHash: record.hash,
          codeSealed: record.sealed,
          failedAttempts: 0,
          lockedAt: null,
          issuedAt: toDate(record.issuedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async replace(market: MarketContext, record: PickupCodeRecord) {
    const updated = await this.prisma.tx(market).orderingPickupCode.updateMany({
      where: { marketId: market.marketId, sellerOrderId: record.sellerOrderId },
      data: {
        codeHash: record.hash,
        codeSealed: record.sealed,
        failedAttempts: 0,
        lockedAt: null,
        issuedAt: toDate(record.issuedAt),
      },
    });
    return updated.count === 1;
  }

  async registerFailure(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    now: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market).orderingPickupCode;
    const where = { marketId: market.marketId, sellerOrderId };
    await tx.updateMany({
      where: { ...where, failedAttempts: { lt: PICKUP_MAX_FAILED_ATTEMPTS } },
      data: { failedAttempts: { increment: 1 } },
    });
    // The increment holds the row's lock until the unit ends, so this reads our own count.
    const row = await tx.findFirst({ where });
    if (row === null) return null;
    if (row.failedAttempts >= PICKUP_MAX_FAILED_ATTEMPTS && row.lockedAt === null) {
      await tx.updateMany({
        where: { ...where, lockedAt: null, failedAttempts: PICKUP_MAX_FAILED_ATTEMPTS },
        data: { lockedAt: toDate(now) },
      });
      return pickupStatusOf({ failedAttempts: row.failedAttempts, lockedAt: now });
    }
    return pickupStatusOf({
      failedAttempts: row.failedAttempts,
      lockedAt: row.lockedAt === null ? null : toInstant(row.lockedAt),
    });
  }
}
