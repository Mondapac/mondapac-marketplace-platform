import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CreditNoteRecord,
  PendingRefund,
  RefundRepository,
} from '../application/ports/refund.repository';
import type { OrderStatus, PaymentState } from '../domain/order';
import type { Refund, RefundReason, RefundState, RefundTarget } from '../domain/refund';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface RefundRow {
  readonly id: string;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly currency: string;
  readonly grossAmount: bigint;
  readonly taxAmount: bigint;
  readonly shippingGrossAmount: bigint;
  readonly shippingTaxAmount: bigint;
  readonly shippingTaxRateBps: number | null;
  readonly shippingTaxInclusive: boolean | null;
  readonly reason: string;
  readonly actorPopulation: string;
  readonly actorAccountId: string;
  readonly state: string;
  readonly stripeIdempotencyKey: string;
  readonly stripeRefundId: string | null;
  readonly attempts: number;
  readonly requestedAt: Date;
  readonly settledAt: Date | null;
  readonly lines: readonly {
    readonly orderLineId: string;
    readonly quantity: number;
    readonly unitsBefore: number;
    readonly grossAmount: bigint;
    readonly taxAmount: bigint;
    readonly taxRateBps: number;
    readonly taxInclusive: boolean;
  }[];
}

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id as Id<'Refund'>,
    orderId: row.orderId as Id<'Order'>,
    sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
    sellerId: row.sellerId as Id<'Seller'>,
    currency: row.currency,
    gross: row.grossAmount,
    tax: row.taxAmount,
    shipping:
      row.shippingGrossAmount === 0n
        ? null
        : {
            gross: row.shippingGrossAmount,
            tax: row.shippingTaxAmount,
            taxRateBps: row.shippingTaxRateBps!,
            taxInclusive: row.shippingTaxInclusive!,
          },
    reason: row.reason as RefundReason,
    actor: {
      population: row.actorPopulation as 'admin' | 'seller',
      accountId: row.actorAccountId as Id<'Account'>,
    },
    state: row.state as RefundState,
    stripeIdempotencyKey: row.stripeIdempotencyKey,
    stripeRefundId: row.stripeRefundId,
    attempts: row.attempts,
    requestedAt: toInstant(row.requestedAt),
    settledAt: row.settledAt === null ? null : toInstant(row.settledAt),
    lines: [...row.lines]
      .sort((a, b) => a.orderLineId.localeCompare(b.orderLineId))
      .map((l) => ({
        orderLineId: l.orderLineId as Id<'OrderLine'>,
        quantity: l.quantity,
        unitsBefore: l.unitsBefore,
        gross: l.grossAmount,
        tax: l.taxAmount,
        taxRateBps: l.taxRateBps,
        taxInclusive: l.taxInclusive,
      })),
  };
}

/**
 * {@link RefundRepository} on `ordering.refunds`, `refund_lines`, `credit_notes` and the refunded
 * sum of `seller_orders`, through the Market-scoped client with `marketId` at the top level of
 * every `where`.
 */
export class PrismaRefundRepository implements RefundRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findTarget(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    owner: { readonly sellerId: Id<'Seller'> } | { readonly orderId: Id<'Order'> },
  ): Promise<RefundTarget | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.orderingSellerOrder.findFirst({
      where: {
        marketId: market.marketId,
        id: sellerOrderId,
        ...('sellerId' in owner ? { sellerId: owner.sellerId } : { orderId: owner.orderId }),
      },
      include: {
        order: true,
        lines: true,
        refunds: { where: { state: { not: 'failed' } }, include: { lines: true } },
      },
    });
    if (row === null) return null;
    const refundedUnits = new Map<Id<'OrderLine'>, number>();
    let refundedShipping = 0n;
    for (const refund of row.refunds) {
      refundedShipping += refund.shippingGrossAmount;
      for (const line of refund.lines) {
        const id = line.orderLineId as Id<'OrderLine'>;
        refundedUnits.set(id, (refundedUnits.get(id) ?? 0) + line.quantity);
      }
    }
    return {
      orderId: row.orderId as Id<'Order'>,
      sellerOrderId: row.id as Id<'SellerOrder'>,
      sellerId: row.sellerId as Id<'Seller'>,
      currency: row.order.currency,
      orderStatus: row.order.status as OrderStatus,
      paymentState: row.order.paymentState as PaymentState,
      paymentIntentId: row.order.stripePaymentIntentId,
      shipping: row.shippingAmount,
      shippingTax: row.shippingTaxAmount,
      shippingTaxRateBps: row.shippingTaxRateBps,
      shippingTaxInclusive: row.shippingTaxInclusive,
      total: row.totalAmount,
      refunded: row.refundedAmount,
      pending: row.refunds.some((refund) => refund.state === 'pending'),
      lines: [...row.lines]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((l) => ({
          id: l.id as Id<'OrderLine'>,
          quantity: l.quantity,
          unitAmount: l.unitAmount,
          taxInclusive: l.taxInclusive,
          taxRateBps: l.taxRateBps,
          taxAmount: l.taxAmount,
        })),
      refundedUnits,
      refundedShipping,
    };
  }

  async reserve(
    market: MarketContext,
    refund: Refund,
    expectedRefunded: bigint,
  ): Promise<'saved' | 'stale'> {
    const tx = this.prisma.tx(market);
    const raised = await tx.orderingSellerOrder.updateMany({
      where: {
        marketId: market.marketId,
        id: refund.sellerOrderId,
        refundedAmount: expectedRefunded,
      },
      data: { refundedAmount: expectedRefunded + refund.gross },
    });
    if (raised.count === 0) return 'stale';
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.orderingRefund.create({
      data: {
        id: refund.id,
        ...scope,
        orderId: refund.orderId,
        sellerOrderId: refund.sellerOrderId,
        sellerId: refund.sellerId,
        currency: refund.currency,
        grossAmount: refund.gross,
        taxAmount: refund.tax,
        shippingGrossAmount: refund.shipping?.gross ?? 0n,
        shippingTaxAmount: refund.shipping?.tax ?? 0n,
        shippingTaxRateBps: refund.shipping?.taxRateBps ?? null,
        shippingTaxInclusive: refund.shipping?.taxInclusive ?? null,
        reason: refund.reason,
        actorPopulation: refund.actor.population,
        actorAccountId: refund.actor.accountId,
        state: refund.state,
        stripeIdempotencyKey: refund.stripeIdempotencyKey,
        stripeRefundId: refund.stripeRefundId,
        attempts: refund.attempts,
        requestedAt: toDate(refund.requestedAt),
        settledAt: null,
      },
    });
    if (refund.lines.length > 0) {
      await tx.orderingRefundLine.createMany({
        data: refund.lines.map((l) => ({
          ...scope,
          refundId: refund.id,
          orderLineId: l.orderLineId,
          quantity: l.quantity,
          unitsBefore: l.unitsBefore,
          grossAmount: l.gross,
          taxAmount: l.tax,
          taxRateBps: l.taxRateBps,
          taxInclusive: l.taxInclusive,
        })),
      });
    }
    return 'saved';
  }

  async markSucceeded(
    market: MarketContext,
    refund: Refund,
    stripeRefundId: string,
    creditNote: CreditNoteRecord,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const settled = await tx.orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refund.id, state: 'pending' },
      data: { state: 'succeeded', stripeRefundId, settledAt: toDate(creditNote.issuedAt) },
    });
    if (settled.count === 0) return false;
    await tx.orderingCreditNote.create({
      data: {
        id: creditNote.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        refundId: refund.id,
        orderId: refund.orderId,
        sellerOrderId: refund.sellerOrderId,
        sellerId: refund.sellerId,
        currency: refund.currency,
        grossAmount: refund.gross,
        taxAmount: refund.tax,
        issuedAt: toDate(creditNote.issuedAt),
      },
    });
    return true;
  }

  async markFailed(market: MarketContext, refund: Refund, at: Temporal.Instant): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const settled = await tx.orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refund.id, state: 'pending' },
      data: { state: 'failed', settledAt: toDate(at) },
    });
    if (settled.count === 0) return false;
    await tx.orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: refund.sellerOrderId },
      data: { refundedAmount: { decrement: refund.gross } },
    });
    return true;
  }

  async countAttempt(market: MarketContext, refundId: Id<'Refund'>): Promise<void> {
    await this.prisma.tx(market).orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refundId, state: 'pending' },
      data: { attempts: { increment: 1 } },
    });
  }

  async findPending(
    market: MarketContext,
    window: { readonly after: Temporal.Instant; readonly before: Temporal.Instant },
    limit: number,
  ): Promise<readonly PendingRefund[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.orderingRefund.findMany({
      where: {
        marketId: market.marketId,
        state: 'pending',
        requestedAt: { gt: toDate(window.after), lt: toDate(window.before) },
      },
      include: { lines: true, sellerOrder: { include: { order: true } } },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.flatMap((row) => {
      const intent = row.sellerOrder.order.stripePaymentIntentId;
      return intent === null ? [] : [{ refund: toRefund(row), paymentIntentId: intent }];
    });
  }
}
