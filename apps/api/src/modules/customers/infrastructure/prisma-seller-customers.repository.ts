import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MonthlyCount,
  SellerCustomerQuery,
  SellerCustomerRepository,
} from '../application/ports/seller-customers.repository';
import {
  firstNameOf,
  SELLER_CUSTOMER_VIEWS,
  type SellerCustomerEntry,
  type SellerCustomerRecord,
  type SellerCustomerSort,
  type SellerCustomerTab,
} from '../domain/seller-customers';

type Where = Prisma.CustomersSellerCustomerWhereInput;
type Row = Prisma.CustomersSellerCustomerGetPayload<{
  include: { directory: { select: { displayName: true } } };
}>;

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00Z`);
const startOfNextDay = (day: string): Date =>
  new Date(Temporal.Instant.from(`${day}T00:00:00Z`).epochMilliseconds + 24 * 3_600_000);

const INCLUDE = { directory: { select: { displayName: true } } } as const;

const recordOf = (row: Row): SellerCustomerRecord => ({
  sellerId: row.sellerId as Id<'Seller'>,
  accountId: row.accountId as Id<'Account'>,
  code: row.customerCode,
  firstName: firstNameOf(row.directory.displayName),
  orderCount: row.orderCount,
  firstOrderAt: row.firstOrderAt === null ? null : toInstant(row.firstOrderAt),
  lastOrderAt: row.lastOrderAt === null ? null : toInstant(row.lastOrderAt),
  spent:
    row.orderCount === 0 || row.currency === null
      ? null
      : { amount: row.spentMinor, currency: row.currency },
  follower: row.follower,
  followedAt: row.followedAt === null ? null : toInstant(row.followedAt),
  exclusive: row.exclusive,
  since: toInstant(row.createdAt),
});

function tabWhere(tab: SellerCustomerTab): Where {
  switch (tab) {
    case 'all':
      return {};
    case 'buyers':
      return { orderCount: { gt: 0 } };
    case 'followers':
      return { follower: true };
    case 'referred':
      return { exclusive: true };
  }
}

function whereOf(market: MarketContext, query: SellerCustomerQuery): Where {
  const { selector } = query;
  const and: Where[] = [tabWhere(selector.view)];
  if (selector.codePrefix !== null) and.push({ customerCode: { startsWith: selector.codePrefix } });
  if (selector.follower !== null) and.push({ follower: selector.follower });
  if (selector.exclusive !== null) and.push({ exclusive: selector.exclusive });
  if (selector.lastOrderFrom !== null || selector.lastOrderTo !== null) {
    and.push({
      lastOrderAt: {
        ...(selector.lastOrderFrom === null ? {} : { gte: startOfDay(selector.lastOrderFrom) }),
        ...(selector.lastOrderTo === null ? {} : { lt: startOfNextDay(selector.lastOrderTo) }),
      },
    });
  }
  if (selector.ordersMin !== null) and.push({ orderCount: { gte: selector.ordersMin } });
  if (selector.ordersMax !== null) and.push({ orderCount: { lte: selector.ordersMax } });
  if (selector.spentMin !== null) and.push({ spentMinor: { gte: selector.spentMin } });
  if (selector.spentMax !== null) and.push({ spentMinor: { lte: selector.spentMax } });
  return { marketId: market.marketId, sellerId: query.sellerId, AND: and };
}

function orderBy(
  sort: SellerCustomerSort,
  direction: 'asc' | 'desc',
): Prisma.CustomersSellerCustomerOrderByWithRelationInput[] {
  const nullsLast = { sort: direction, nulls: 'last' } as const;
  const tie = { accountId: direction } as const;
  switch (sort) {
    case 'last-order':
      return [{ lastOrderAt: nullsLast }, tie];
    case 'first-order':
      return [{ firstOrderAt: nullsLast }, tie];
    case 'orders':
      return [{ orderCount: direction }, tie];
    case 'spent':
      return [{ spentMinor: direction }, tie];
    case 'followed':
      return [{ followedAt: nullsLast }, tie];
    case 'code':
      return [{ customerCode: direction }];
  }
}

/**
 * {@link SellerCustomerRepository} on `customers.seller_customers`, with the first name read from
 * the customer's directory row through the foreign key (one module's own tables). Every statement
 * carries `marketId`, and a list statement the seller; no raw SQL.
 */
export class PrismaSellerCustomerRepository implements SellerCustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async codesOfAccount(market: MarketContext, accountId: Id<'Account'>) {
    const rows = await this.prisma.tx(market).customersSellerCustomer.findMany({
      where: { marketId: market.marketId, accountId },
      select: { sellerId: true, customerCode: true },
    });
    return new Map(rows.map((row) => [row.sellerId as Id<'Seller'>, row.customerCode]));
  }

  async codeTaken(market: MarketContext, sellerId: Id<'Seller'>, code: string) {
    const row = await this.prisma.tx(market).customersSellerCustomer.findFirst({
      where: { marketId: market.marketId, sellerId, customerCode: code },
      select: { accountId: true },
    });
    return row !== null;
  }

  async upsert(
    market: MarketContext,
    entry: SellerCustomerEntry,
    code: string,
    now: Temporal.Instant,
  ) {
    const values = {
      orderCount: entry.orderCount,
      firstOrderAt: entry.firstOrderAt === null ? null : toDate(entry.firstOrderAt),
      lastOrderAt: entry.lastOrderAt === null ? null : toDate(entry.lastOrderAt),
      spentMinor: entry.spentMinor,
      currency: entry.currency,
      follower: entry.follower,
      followedAt: entry.followedAt === null ? null : toDate(entry.followedAt),
      exclusive: entry.exclusive,
      updatedAt: toDate(now),
    };
    // Replace when present, else insert: the Market guard takes no `upsert`. The insert does not
    // skip duplicates, so a code another customer of the seller holds (or a concurrent insert of
    // the same row) fails the unit instead of being dropped; the delivery or the reconcile retries.
    const tx = this.prisma.tx(market);
    const updated = await tx.customersSellerCustomer.updateMany({
      where: { marketId: market.marketId, sellerId: entry.sellerId, accountId: entry.accountId },
      data: values,
    });
    if (updated.count > 0) return;
    await tx.customersSellerCustomer.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: entry.sellerId,
          accountId: entry.accountId,
          customerCode: code,
          createdAt: toDate(now),
          ...values,
        },
      ],
    });
  }

  async removeSellers(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ) {
    if (sellerIds.length === 0) return;
    await this.prisma.tx(market).customersSellerCustomer.deleteMany({
      where: { marketId: market.marketId, accountId, sellerId: { in: [...sellerIds] } },
    });
  }

  async page(
    market: MarketContext,
    query: SellerCustomerQuery,
    order: { readonly sort: SellerCustomerSort; readonly direction: 'asc' | 'desc' },
    window: { readonly offset: number; readonly limit: number },
  ) {
    const rows = await this.prisma.tx(market).customersSellerCustomer.findMany({
      where: whereOf(market, query),
      include: INCLUDE,
      orderBy: orderBy(order.sort, order.direction),
      skip: window.offset,
      take: window.limit,
    });
    return rows.map(recordOf);
  }

  count(market: MarketContext, query: SellerCustomerQuery) {
    return this.prisma.tx(market).customersSellerCustomer.count({ where: whereOf(market, query) });
  }

  async tabCounts(market: MarketContext, sellerId: Id<'Seller'>) {
    const counts = await Promise.all(
      SELLER_CUSTOMER_VIEWS.map((tab) =>
        this.prisma.tx(market).customersSellerCustomer.count({
          where: { marketId: market.marketId, sellerId, ...tabWhere(tab) },
        }),
      ),
    );
    return Object.fromEntries(
      SELLER_CUSTOMER_VIEWS.map((tab, index) => [tab, counts[index]!]),
    ) as Record<SellerCustomerTab, number>;
  }

  async findByCode(market: MarketContext, sellerId: Id<'Seller'>, code: string) {
    const row = await this.prisma.tx(market).customersSellerCustomer.findFirst({
      where: { marketId: market.marketId, sellerId, customerCode: code },
      include: INCLUDE,
    });
    return row === null ? null : recordOf(row);
  }

  async findByAccounts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    accountIds: readonly Id<'Account'>[],
  ) {
    if (accountIds.length === 0) return [];
    const rows = await this.prisma.tx(market).customersSellerCustomer.findMany({
      where: { marketId: market.marketId, sellerId, accountId: { in: [...accountIds] } },
      include: INCLUDE,
    });
    return rows.map(recordOf);
  }

  async findByCodes(market: MarketContext, sellerId: Id<'Seller'>, codes: readonly string[]) {
    if (codes.length === 0) return [];
    const rows = await this.prisma.tx(market).customersSellerCustomer.findMany({
      where: { marketId: market.marketId, sellerId, customerCode: { in: [...codes] } },
      include: INCLUDE,
    });
    const byCode = new Map(rows.map((row) => [row.customerCode, recordOf(row)]));
    return codes.flatMap((code) => {
      const record = byCode.get(code);
      return record === undefined ? [] : [record];
    });
  }

  async monthly(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    months: readonly {
      readonly month: string;
      readonly from: Temporal.Instant;
      readonly to: Temporal.Instant;
    }[],
  ): Promise<readonly MonthlyCount[]> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, sellerId };
    return Promise.all(
      months.map(async ({ month, from, to }) => {
        const range = { gte: toDate(from), lt: toDate(to) };
        const [newBuyers, newFollowers] = await Promise.all([
          tx.customersSellerCustomer.count({ where: { ...base, firstOrderAt: range } }),
          tx.customersSellerCustomer.count({ where: { ...base, followedAt: range } }),
        ]);
        return { month, newBuyers, newFollowers };
      }),
    );
  }
}
