import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminRefundListReader } from '../application/ports/admin-refund-list.reader';
import type {
  RefundListFilter,
  RefundListRecord,
  RefundSort,
  RefundStateCounts,
} from '../domain/admin-refund-list';
import type { LossBearer, LossReasonCode } from '../domain/reason-codes';
import type { RefundReason, RefundState } from '../domain/refund';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const SELECT = {
  id: true,
  orderId: true,
  sellerOrderId: true,
  sellerId: true,
  currency: true,
  grossAmount: true,
  taxAmount: true,
  shippingGrossAmount: true,
  reason: true,
  actorPopulation: true,
  state: true,
  lossBearer: true,
  lossReasonCode: true,
  stripeRefundId: true,
  requestedAt: true,
  settledAt: true,
  ledgerRecordedAt: true,
  creditNote: { select: { id: true } },
  sellerOrder: { select: { order: { select: { accountId: true } } } },
} as const;

/** The WHERE of a filter; every branch keeps the Market's own rows only. */
function where(market: MarketContext, filter: RefundListFilter) {
  const and: object[] = [];
  if (filter.reference !== null) {
    and.push({
      OR: [
        { id: filter.reference },
        { orderId: filter.reference },
        { sellerOrderId: filter.reference },
      ],
    });
  }
  if (filter.ledger !== null) {
    // In AND, so a `state` filter beside it narrows instead of being replaced.
    and.push(
      filter.ledger === 'recorded'
        ? { ledgerRecordedAt: { not: null } }
        : { state: 'succeeded', ledgerRecordedAt: null },
    );
  }
  if (filter.parties !== null) {
    and.push({
      OR: [
        { sellerId: { in: [...filter.parties.sellerIds] } },
        {
          sellerOrder: {
            order: { marketId: market.marketId, accountId: { in: [...filter.parties.accountIds] } },
          },
        },
      ],
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.state === null ? {} : { state: filter.state }),
    ...(filter.stripeRefundId === null ? {} : { stripeRefundId: filter.stripeRefundId }),
    ...(filter.reason === null ? {} : { reason: filter.reason }),
    ...(filter.actor === null ? {} : { actorPopulation: filter.actor }),
    ...(filter.lossBearer === null ? {} : { lossBearer: filter.lossBearer }),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          requestedAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : {
          grossAmount: {
            ...(filter.minAmount === null ? {} : { gte: filter.minAmount }),
            ...(filter.maxAmount === null ? {} : { lte: filter.maxAmount }),
          },
        }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

function orderBy(sort: RefundSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'amount':
      return [{ grossAmount: sort.direction }, tie];
    case 'settled':
      // A refund Stripe has not answered has no settle time: it goes last either way.
      return [{ settledAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    default:
      return [{ requestedAt: sort.direction }, tie];
  }
}

/** The admin Refunds list over `ordering.refunds`, its order and its credit note. */
export class PrismaAdminRefundListReader implements AdminRefundListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: RefundListFilter,
    sort: RefundSort,
    offset: number,
    limit: number,
  ): Promise<readonly RefundListRecord[]> {
    const rows = await this.prisma.tx(market).orderingRefund.findMany({
      where: where(market, filter),
      select: SELECT,
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map((row) => ({
      refundId: row.id as Id<'Refund'>,
      orderId: row.orderId as Id<'Order'>,
      sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
      sellerId: row.sellerId as Id<'Seller'>,
      accountId: row.sellerOrder.order.accountId as Id<'Account'>,
      gross: { amount: row.grossAmount, currency: row.currency },
      tax: { amount: row.taxAmount, currency: row.currency },
      shippingGross: { amount: row.shippingGrossAmount, currency: row.currency },
      reason: row.reason as RefundReason,
      actor: row.actorPopulation as 'admin' | 'seller',
      state: row.state as RefundState,
      lossBearer: row.lossBearer as LossBearer,
      lossReasonCode: row.lossReasonCode as LossReasonCode | null,
      stripeRefundId: row.stripeRefundId,
      requestedAt: toInstant(row.requestedAt),
      settledAt: row.settledAt === null ? null : toInstant(row.settledAt),
      ledgerRecordedAt: row.ledgerRecordedAt === null ? null : toInstant(row.ledgerRecordedAt),
      creditNoteId: (row.creditNote?.id ?? null) as Id<'CreditNote'> | null,
    }));
  }

  count(market: MarketContext, filter: RefundListFilter): Promise<number> {
    return this.prisma.tx(market).orderingRefund.count({ where: where(market, filter) });
  }

  async countByState(market: MarketContext): Promise<RefundStateCounts> {
    const groups = await this.prisma.tx(market).orderingRefund.groupBy({
      by: ['state'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const count = (state: RefundState) =>
      groups.find((group) => group.state === state)?._count._all ?? 0;
    return { pending: count('pending'), succeeded: count('succeeded'), failed: count('failed') };
  }
}
