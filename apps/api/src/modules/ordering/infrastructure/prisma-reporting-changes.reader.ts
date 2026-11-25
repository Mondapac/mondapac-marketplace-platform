import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ReportingChangesReader } from '../application/ports/reporting-changes.reader';
import type {
  ReportCheckout,
  ReportChangesPage,
  ReportWindow,
  SellerOrderRef,
} from '../contracts/ordering-reporting.facade';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/** `[from, to)` as a Prisma range; `from` null is open below. */
function range(window: ReportWindow): { gte?: Date; lt: Date } {
  return window.from === null
    ? { lt: toDate(window.to) }
    : { gte: toDate(window.from), lt: toDate(window.to) };
}

/**
 * {@link ReportingChangesReader} on `ordering.seller_orders` (with its order's cancellation) and
 * `ordering.refunds`, keyset-paged by id through the primary key, every statement scoped by
 * `market_id`. Reads ids only.
 */
export class PrismaReportingChangesReader implements ReportingChangesReader {
  constructor(private readonly prisma: PrismaService) {}

  async sellerOrdersChanged(
    market: MarketContext,
    window: ReportWindow,
    after: Id<'SellerOrder'> | null,
    limit: number,
  ): Promise<ReportChangesPage<SellerOrderRef>> {
    const within = range(window);
    const rows = await this.prisma.tx(market).orderingSellerOrder.findMany({
      where: {
        marketId: market.marketId,
        ...(after === null ? {} : { id: { gt: after } }),
        OR: [
          { paidAt: within },
          { readyAt: within },
          { shippedAt: within },
          { deliveredAt: within },
          { order: { marketId: market.marketId, cancelledAt: within } },
        ],
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: { id: true, orderId: true },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        orderId: row.orderId as Id<'Order'>,
        sellerOrderId: row.id as Id<'SellerOrder'>,
      })),
      next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async refundsSucceeded(
    market: MarketContext,
    window: ReportWindow,
    after: Id<'Refund'> | null,
    limit: number,
  ): Promise<ReportChangesPage<Id<'Refund'>>> {
    const rows = await this.prisma.tx(market).orderingRefund.findMany({
      where: {
        marketId: market.marketId,
        ...(after === null ? {} : { id: { gt: after } }),
        state: 'succeeded',
        settledAt: range(window),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: { id: true },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => row.id as Id<'Refund'>),
      next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async checkoutsStarted(
    market: MarketContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<ReportCheckout[]> {
    // Every status is named so the (market_id, status, created_at) index serves the window.
    const rows = await this.prisma.tx(market).orderingOrder.groupBy({
      by: ['accountId'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        status: { in: ['pending-payment', 'confirmed', 'cancelled'] },
        createdAt: { gte: toDate(window.from), lt: toDate(window.to) },
      },
      _max: { confirmedAt: true },
      orderBy: { accountId: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      accountId: row.accountId as Id<'Account'>,
      paid: row._max.confirmedAt !== null,
    }));
  }
}
