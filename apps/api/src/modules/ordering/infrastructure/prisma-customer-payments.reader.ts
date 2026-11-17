import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Money } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CustomerPaymentFact,
  CustomerPaymentsQuery,
  CustomerPaymentsReader,
  CustomerPaymentsSort,
} from '../application/ports/customer-payments.reader';
import type { OrderStatus, PaymentState } from '../domain/order';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

function whereOf(
  market: MarketContext,
  query: CustomerPaymentsQuery,
): Prisma.OrderingOrderWhereInput {
  return {
    marketId: market.marketId,
    accountId: query.accountId,
    ...(query.paymentStates === null ? {} : { paymentState: { in: [...query.paymentStates] } }),
    ...(query.statuses === null ? {} : { status: { in: [...query.statuses] } }),
    ...(query.from === null && query.to === null
      ? {}
      : {
          createdAt: {
            ...(query.from === null ? {} : { gte: new Date(query.from.epochMilliseconds) }),
            ...(query.to === null ? {} : { lt: new Date(query.to.epochMilliseconds) }),
          },
        }),
  };
}

/** {@link CustomerPaymentsReader} over `ordering.orders`: the payment columns only. */
export class PrismaCustomerPaymentsReader implements CustomerPaymentsReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    query: CustomerPaymentsQuery,
    order: { readonly sort: CustomerPaymentsSort; readonly direction: 'asc' | 'desc' },
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerPaymentFact[]> {
    const { direction } = order;
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: whereOf(market, query),
      select: {
        id: true,
        status: true,
        paymentState: true,
        currency: true,
        totalAmount: true,
        stripePaymentIntentId: true,
        createdAt: true,
        confirmedAt: true,
      },
      orderBy:
        order.sort === 'amount'
          ? [{ totalAmount: direction }, { createdAt: direction }, { id: direction }]
          : [{ createdAt: direction }, { id: direction }],
      skip: window.offset,
      take: window.limit,
    });
    return rows.map((row) => ({
      orderId: row.id as Id<'Order'>,
      status: row.status as OrderStatus,
      paymentState: row.paymentState as PaymentState,
      amount: money(row.totalAmount, row.currency),
      providerPaymentId: row.stripePaymentIntentId,
      createdAt: toInstant(row.createdAt),
      confirmedAt: row.confirmedAt === null ? null : toInstant(row.confirmedAt),
    }));
  }

  count(market: MarketContext, query: CustomerPaymentsQuery): Promise<number> {
    return this.prisma.tx(market).orderingOrder.count({ where: whereOf(market, query) });
  }

  async paidTotals(market: MarketContext, accountId: Id<'Account'>): Promise<readonly Money[]> {
    const groups = await this.prisma.tx(market).orderingOrder.groupBy({
      by: ['currency'],
      where: { marketId: market.marketId, accountId, paymentState: 'captured' },
      _sum: { totalAmount: true },
      orderBy: { currency: 'asc' },
    });
    return groups.map((group) => money(group._sum.totalAmount ?? 0n, group.currency));
  }

  async orderIds(
    market: MarketContext,
    accountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly Id<'Order'>[]> {
    const rows = await this.prisma.tx(market).orderingOrder.findMany({
      where: { marketId: market.marketId, accountId },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => row.id as Id<'Order'>);
  }
}
