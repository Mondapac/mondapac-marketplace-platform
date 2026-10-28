import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AddressRecord, AddressRepository } from '../application/ports/address.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const toRecord = (row: {
  readonly id: string;
  readonly accountId: string;
  readonly contentCiphertext: string;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AddressRecord => ({
  id: row.id as Id<'CustomerAddress'>,
  accountId: row.accountId as Id<'Account'>,
  sealed: row.contentCiphertext,
  countryCode: row.countryCode,
  isDefault: row.isDefault,
  createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
});

/**
 * {@link AddressRepository} on `customers.addresses`, scoped by `marketId` and the owning
 * `accountId` in every `where`.
 */
export class PrismaAddressRepository implements AddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, accountId: Id<'Account'>) {
    const rows = await this.prisma.tx(market).customersAddress.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toRecord);
  }

  async find(market: MarketContext, accountId: Id<'Account'>, id: Id<'CustomerAddress'>) {
    const row = await this.prisma.tx(market).customersAddress.findFirst({
      where: { marketId: market.marketId, accountId, id },
    });
    return row === null ? null : toRecord(row);
  }

  async insert(market: MarketContext, record: AddressRecord): Promise<void> {
    await this.prisma.tx(market).customersAddress.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: record.accountId,
        contentCiphertext: record.sealed,
        countryCode: record.countryCode,
        isDefault: record.isDefault,
        createdAt: toDate(record.createdAt),
        updatedAt: toDate(record.updatedAt),
      },
    });
  }

  async update(
    market: MarketContext,
    record: Parameters<AddressRepository['update']>[1],
  ): Promise<boolean> {
    const changed = await this.prisma.tx(market).customersAddress.updateMany({
      where: { marketId: market.marketId, accountId: record.accountId, id: record.id },
      data: { contentCiphertext: record.sealed, updatedAt: toDate(record.updatedAt) },
    });
    return changed.count > 0;
  }

  async markDefault(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
    updatedAt: Temporal.Instant,
  ): Promise<boolean> {
    const changed = await this.prisma.tx(market).customersAddress.updateMany({
      where: { marketId: market.marketId, accountId, id },
      data: { isDefault: true, updatedAt: toDate(updatedAt) },
    });
    return changed.count > 0;
  }

  async clearDefault(
    market: MarketContext,
    accountId: Id<'Account'>,
    updatedAt: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).customersAddress.updateMany({
      where: { marketId: market.marketId, accountId, isDefault: true },
      data: { isDefault: false, updatedAt: toDate(updatedAt) },
    });
  }

  async remove(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
  ): Promise<boolean> {
    const removed = await this.prisma.tx(market).customersAddress.deleteMany({
      where: { marketId: market.marketId, accountId, id },
    });
    return removed.count > 0;
  }

  async removeAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    const removed = await this.prisma.tx(market).customersAddress.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return removed.count;
  }
}
