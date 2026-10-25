import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CreditNoteRecord,
  PendingRefund,
  RefundForLedger,
  RefundRepository,
} from '../application/ports/refund.repository';
import type { LedgerState, OrderStatus, PaymentState } from '../domain/order';
import type {
  LossBearer,
  LossReasonCode,
  Refund,
  RefundReason,
  RefundState,
  RefundTarget,
} from '../domain/refund';

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
  readonly lossBearer: string;
  readonly lossReasonCode: string | null;
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
    readonly lineQuantity: number;
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
    lossBearer: row.lossBearer as LossBearer,
    lossReasonCode: row.lossReasonCode as LossReasonCode | null,
    actor: {
      population: row.actorPopulation as 'admin',
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
        lineQuantity: l.lineQuantity,
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
    orderId: Id<'Order'>,
  ): Promise<RefundTarget | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.orderingSellerOrder.findFirst({
      where: { marketId: market.marketId, id: sellerOrderId, orderId },
      include: {
        order: true,
        lines: true,
        refunds: { where: { state: { not: 'failed' } }, include: { lines: true } },
      },
    });
    if (row === null) return null;
    const refundedUnits = new Map<Id<'OrderLine'>, number>();
    const succeededUnits = new Map<Id<'OrderLine'>, number>();
    let refundedShipping = 0n;
    for (const refund of row.refunds) {
      refundedShipping += refund.shippingGrossAmount;
      for (const line of refund.lines) {
        const id = line.orderLineId as Id<'OrderLine'>;
        refundedUnits.set(id, (refundedUnits.get(id) ?? 0) + line.quantity);
        if (refund.state === 'succeeded') {
          succeededUnits.set(id, (succeededUnits.get(id) ?? 0) + line.quantity);
        }
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
      succeededUnits,
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
        order: { is: { status: 'confirmed', paymentState: 'captured' } },
      },
      data: { refundedAmount: expectedRefunded + refund.gross },
    });
    if (raised.count === 0) return 'stale';
    // The raise holds the seller order's row lock, so this read sees every refund that became
    // pending before it; `stale` rolls the raise back with the unit (never a unique-index 500).
    const pending = await tx.orderingRefund.findFirst({
      where: { marketId: market.marketId, sellerOrderId: refund.sellerOrderId, state: 'pending' },
      select: { id: true },
    });
    if (pending !== null) return 'stale';
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
        lossBearer: refund.lossBearer,
        lossReasonCode: refund.lossReasonCode,
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
          sellerOrderId: refund.sellerOrderId,
          orderLineId: l.orderLineId,
          quantity: l.quantity,
          lineQuantity: l.lineQuantity,
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

  async markFailed(
    market: MarketContext,
    refund: Refund,
    at: Temporal.Instant,
    stripeRefundId: string | null,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const settled = await tx.orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refund.id, state: 'pending' },
      data: {
        state: 'failed',
        settledAt: toDate(at),
        ...(stripeRefundId === null ? {} : { stripeRefundId }),
      },
    });
    if (settled.count === 0) return false;
    await tx.orderingSellerOrder.updateMany({
      where: { marketId: market.marketId, id: refund.sellerOrderId },
      data: { refundedAmount: { decrement: refund.gross } },
    });
    return true;
  }

  async countAttempt(
    market: MarketContext,
    refund: Refund,
    stripeRefundId: string | null,
  ): Promise<void> {
    await this.prisma.tx(market).orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refund.id, state: 'pending' },
      data: {
        attempts: { increment: 1 },
        ...(stripeRefundId === null ? {} : { stripeRefundId }),
      },
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
        requestedAt: { lt: toDate(window.before) },
        OR: [{ stripeRefundId: { not: null } }, { requestedAt: { gt: toDate(window.after) } }],
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

  async findUnrecordedLedger(
    market: MarketContext,
    limit: number,
  ): Promise<readonly RefundForLedger[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.orderingRefund.findMany({
      where: {
        marketId: market.marketId,
        state: 'succeeded',
        ledgerRecordedAt: null,
        // A refund waits until the paid facts of its seller order are in the ledger.
        sellerOrder: { is: { ledgerState: { not: 'pending' } } },
      },
      include: { lines: true, sellerOrder: true },
      orderBy: [{ ledgerAttempts: 'asc' }, { requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const found: RefundForLedger[] = [];
    for (const row of rows) {
      // The shipping gross of the refunds before this one that did not fail: refunds of one
      // seller order are made one after the other, so (requested at, id) is their order.
      const earlier = await tx.orderingRefund.aggregate({
        where: {
          marketId: market.marketId,
          sellerOrderId: row.sellerOrderId,
          state: { not: 'failed' },
          OR: [
            { requestedAt: { lt: row.requestedAt } },
            { requestedAt: row.requestedAt, id: { lt: row.id } },
          ],
        },
        _sum: { shippingGrossAmount: true },
      });
      const seller = row.sellerOrder;
      found.push({
        refund: toRefund(row),
        sellerOrderLedgerState: seller.ledgerState as LedgerState,
        shippingCharge:
          seller.shippingTaxAmount === null || seller.shippingTaxInclusive === null
            ? null
            : seller.shippingAmount + (seller.shippingTaxInclusive ? 0n : seller.shippingTaxAmount),
        shippingBefore: earlier._sum.shippingGrossAmount ?? 0n,
      });
    }
    return found;
  }

  async countLedgerFailure(market: MarketContext, refundId: Id<'Refund'>): Promise<number> {
    const tx = this.prisma.tx(market);
    const updated = await tx.orderingRefund.updateMany({
      where: { marketId: market.marketId, id: refundId, ledgerRecordedAt: null },
      data: { ledgerAttempts: { increment: 1 } },
    });
    if (updated.count === 0) return 0;
    // The increment holds the row's lock until the unit ends, so this reads our own count.
    const row = await tx.orderingRefund.findFirst({
      where: { marketId: market.marketId, id: refundId },
      select: { ledgerAttempts: true },
    });
    return row?.ledgerAttempts ?? 0;
  }

  async markLedgerRecorded(
    market: MarketContext,
    refundId: Id<'Refund'>,
    at: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).orderingRefund.updateMany({
      where: {
        marketId: market.marketId,
        id: refundId,
        state: 'succeeded',
        ledgerRecordedAt: null,
      },
      data: { ledgerRecordedAt: toDate(at) },
    });
  }
}
