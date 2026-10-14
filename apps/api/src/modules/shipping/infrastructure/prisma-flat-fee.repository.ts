import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { FlatFeeRecord, FlatFeeRepository } from '../application/ports/flat-fee.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface Row {
  readonly sellerId: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly updatedAt: Date;
}

const toRecord = (row: Row): FlatFeeRecord => ({
  sellerId: row.sellerId as Id<'Seller'>,
  fee: money(row.amount, row.currency),
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
});

/** {@link FlatFeeRepository} on `shipping.seller_flat_fees`, scoped by `marketId` in every `where`. */
export class PrismaFlatFeeRepository implements FlatFeeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma
      .tx(market)
      .shippingSellerFlatFee.findFirst({ where: { marketId: market.marketId, sellerId } });
    return row === null ? null : toRecord(row);
  }

  async findMany(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const rows = await this.prisma.tx(market).shippingSellerFlatFee.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    return rows.map(toRecord);
  }

  async save(
    market: MarketContext,
    record: FlatFeeRecord & { readonly updatedBy: Id<'Account'> },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = {
      amount: record.fee.amount,
      currency: record.fee.currency,
      updatedAt: toDate(record.updatedAt),
      updatedBy: record.updatedBy,
    };
    const created = await tx.shippingSellerFlatFee.createMany({
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
      await tx.shippingSellerFlatFee.updateMany({
        where: { marketId: market.marketId, sellerId: record.sellerId },
        data,
      });
    }
  }
}
