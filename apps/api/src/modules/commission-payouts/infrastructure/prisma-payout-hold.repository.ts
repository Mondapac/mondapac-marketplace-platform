import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PayoutHoldRecord,
  PayoutHoldRepository,
} from '../application/ports/payout-hold.repository';
import type { HoldOrigin, HoldReason, ReleaseReason } from '../domain/payout-hold';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly sellerId: string;
  readonly sellerOrderId: string | null;
  readonly reason: string;
  readonly origin: string;
  readonly sourceRef: string;
  readonly placedBy: string | null;
  readonly placedAt: Date;
  readonly releasedAt: Date | null;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
}

const toRecord = (row: Row): PayoutHoldRecord => ({
  id: row.id as Id<'PayoutHold'>,
  sellerId: row.sellerId as Id<'Seller'>,
  sellerOrderId: row.sellerOrderId as Id<'SellerOrder'> | null,
  reason: row.reason as HoldReason,
  origin: row.origin as HoldOrigin,
  sourceRef: row.sourceRef,
  placedBy: row.placedBy as Id<'Account'> | null,
  placedAt: toInstant(row.placedAt),
  releasedAt: row.releasedAt === null ? null : toInstant(row.releasedAt),
  releasedBy: row.releasedBy as Id<'Account'> | null,
  releaseReason: row.releaseReason as ReleaseReason | null,
});

/**
 * {@link PayoutHoldRepository} on `commission_payouts.payout_holds`, scoped by `marketId` in every
 * `where`. It inserts and sets the release columns; a trigger refuses any other change.
 */
export class PrismaPayoutHoldRepository implements PayoutHoldRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertIfAbsent(market: MarketContext, hold: PayoutHoldRecord): Promise<boolean> {
    const created = await this.prisma.tx(market).commissionPayoutsPayoutHold.createMany({
      data: [
        {
          id: hold.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: hold.sellerId,
          sellerOrderId: hold.sellerOrderId,
          reason: hold.reason,
          origin: hold.origin,
          sourceRef: hold.sourceRef,
          placedBy: hold.placedBy,
          placedAt: toDate(hold.placedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async find(market: MarketContext, holdId: Id<'PayoutHold'>) {
    const row = await this.prisma.tx(market).commissionPayoutsPayoutHold.findFirst({
      where: { marketId: market.marketId, id: holdId },
    });
    return row === null ? null : toRecord(row);
  }

  async release(
    market: MarketContext,
    holdId: Id<'PayoutHold'>,
    release: {
      readonly releasedAt: Temporal.Instant;
      readonly releasedBy: Id<'Account'>;
      readonly reason: ReleaseReason;
    },
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).commissionPayoutsPayoutHold.updateMany({
      where: { marketId: market.marketId, id: holdId, releasedAt: null },
      data: {
        releasedAt: toDate(release.releasedAt),
        releasedBy: release.releasedBy,
        releaseReason: release.reason,
      },
    });
    return updated.count > 0;
  }

  async listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    options: { readonly activeOnly: boolean; readonly limit: number },
  ) {
    // Every active hold, however many and however old (a hold that is not listed is a hold that
    // is not honoured), then the newest released ones up to the limit.
    const tx = this.prisma.tx(market);
    const order = [{ placedAt: 'desc' as const }, { id: 'desc' as const }];
    const active = await tx.commissionPayoutsPayoutHold.findMany({
      where: { marketId: market.marketId, sellerId, releasedAt: null },
      orderBy: order,
    });
    if (options.activeOnly) return active.map(toRecord);
    const released = await tx.commissionPayoutsPayoutHold.findMany({
      where: { marketId: market.marketId, sellerId, releasedAt: { not: null } },
      orderBy: order,
      take: options.limit,
    });
    return [...active, ...released].map(toRecord);
  }
}
