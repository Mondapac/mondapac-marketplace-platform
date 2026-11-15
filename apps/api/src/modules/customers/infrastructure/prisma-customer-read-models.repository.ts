import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CustomerReadModelRepository } from '../application/ports/customer-read-models.repository';
import {
  emailSearchKey,
  type CustomerDirectoryEntry,
  type CustomerStatsEntry,
} from '../domain/customer-read-models';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** {@link CustomerReadModelRepository} on `customers.customer_directory` and `customer_stats`. */
export class PrismaCustomerReadModelRepository implements CustomerReadModelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertDirectory(
    market: MarketContext,
    entry: CustomerDirectoryEntry,
    now: Temporal.Instant,
  ): Promise<void> {
    const data = {
      email: entry.email,
      emailLower: emailSearchKey(entry.email),
      displayName: entry.displayName,
      status: entry.status,
      emailVerified: entry.emailVerified,
      signedUpAt: toDate(entry.signedUpAt),
      updatedAt: toDate(now),
    };
    // Insert when absent, then replace every field: two statements that converge whichever of two
    // concurrent writers goes first (the Market guard takes no `upsert`).
    const tx = this.prisma.tx(market);
    await tx.customersCustomerDirectory.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: entry.accountId,
          ...data,
        },
      ],
      skipDuplicates: true,
    });
    await tx.customersCustomerDirectory.updateMany({
      where: { marketId: market.marketId, accountId: entry.accountId },
      data,
    });
  }

  async hasDirectory(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    const count = await this.prisma.tx(market).customersCustomerDirectory.count({
      where: { marketId: market.marketId, accountId },
    });
    return count > 0;
  }

  async upsertStats(
    market: MarketContext,
    entry: CustomerStatsEntry,
    now: Temporal.Instant,
  ): Promise<void> {
    const data = {
      firstOrderAt: entry.firstOrderAt === null ? null : toDate(entry.firstOrderAt),
      lastOrderAt: entry.lastOrderAt === null ? null : toDate(entry.lastOrderAt),
      orderCount: entry.orderCount,
      spentMinor: entry.spentMinor,
      currency: entry.currency,
      refundCount: entry.refundCount,
      refundedMinor: entry.refundedMinor,
      computedAt: toDate(now),
    };
    const tx = this.prisma.tx(market);
    await tx.customersCustomerStats.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: entry.accountId,
          ...data,
        },
      ],
      skipDuplicates: true,
    });
    await tx.customersCustomerStats.updateMany({
      where: { marketId: market.marketId, accountId: entry.accountId },
      data,
    });
  }

  async findStats(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<CustomerStatsEntry | null> {
    const row = await this.prisma.tx(market).customersCustomerStats.findFirst({
      where: { marketId: market.marketId, accountId },
    });
    if (row === null) return null;
    return {
      accountId,
      firstOrderAt: row.firstOrderAt === null ? null : toInstant(row.firstOrderAt),
      lastOrderAt: row.lastOrderAt === null ? null : toInstant(row.lastOrderAt),
      orderCount: row.orderCount,
      spentMinor: row.spentMinor,
      currency: row.currency,
      refundCount: row.refundCount,
      refundedMinor: row.refundedMinor,
    };
  }

  async directoryIds(market: MarketContext, after: Id<'Account'> | null, limit: number) {
    const rows = await this.prisma.tx(market).customersCustomerDirectory.findMany({
      where: { marketId: market.marketId, ...(after === null ? {} : { accountId: { gt: after } }) },
      orderBy: { accountId: 'asc' },
      take: limit,
      select: { accountId: true },
    });
    return rows.map((row) => row.accountId as Id<'Account'>);
  }

  async removeAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<void> {
    const tx = this.prisma.tx(market);
    // One statement and one lock order (the sync writes the directory row first): the stats row
    // goes with its directory row through the foreign key's cascade. A stats row without a
    // directory row cannot exist.
    await tx.customersCustomerDirectory.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
  }
}
