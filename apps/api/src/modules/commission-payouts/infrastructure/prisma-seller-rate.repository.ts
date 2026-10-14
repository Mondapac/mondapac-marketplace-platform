import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SellerRateRecord,
  SellerRateRepository,
} from '../application/ports/seller-rate.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const toRecord = (row: {
  readonly sellerId: string;
  readonly rateBps: number;
  readonly updatedAt: Date;
}): SellerRateRecord => ({
  sellerId: row.sellerId as Id<'Seller'>,
  rateBps: row.rateBps,
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
});

/**
 * {@link SellerRateRepository} on `commission_payouts.seller_commission_rates`, scoped by
 * `marketId` in every `where`.
 */
export class PrismaSellerRateRepository implements SellerRateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).commissionPayoutsSellerCommissionRate.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : toRecord(row);
  }

  async findMany(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const rows = await this.prisma.tx(market).commissionPayoutsSellerCommissionRate.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    return rows.map(toRecord);
  }

  async save(
    market: MarketContext,
    record: SellerRateRecord & { readonly updatedBy: Id<'Account'> },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = {
      rateBps: record.rateBps,
      updatedAt: toDate(record.updatedAt),
      updatedBy: record.updatedBy,
    };
    const created = await tx.commissionPayoutsSellerCommissionRate.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: record.sellerId,
          ...data,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      await tx.commissionPayoutsSellerCommissionRate.updateMany({
        where: { marketId: market.marketId, sellerId: record.sellerId },
        data,
      });
    }
  }

  async remove(market: MarketContext, sellerId: Id<'Seller'>): Promise<boolean> {
    const removed = await this.prisma.tx(market).commissionPayoutsSellerCommissionRate.deleteMany({
      where: { marketId: market.marketId, sellerId },
    });
    return removed.count > 0;
  }
}
