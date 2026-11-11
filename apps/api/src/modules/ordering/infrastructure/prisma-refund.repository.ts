import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CreditNoteRecord,
  PendingRefund,
  RefundForLedger,
  RefundLimits,
  RefundRepository,
  SellerRefundGuard,
} from '../application/ports/refund.repository';
import type { RefundLimit } from '../domain/refund-limits';
import type { Fulfilment, LedgerState, OrderStatus, PaymentState } from '../domain/order';
import type {
  LossBearer,
  LossReasonCode,
  Refund,
  RefundActor,
  RefundReason,
  RefundState,
  RefundTarget,
} from '../domain/refund';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface LimitRow {
  readonly id: string;
  readonly sellerId: string | null;
  readonly maxCount: number;
  readonly maxAmount: bigint;
  readonly currency: string;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAccountId: string;
}

function toLimit(row: LimitRow): RefundLimit {
  return {
    id: row.id as Id<'SellerRefundLimit'>,
    sellerId: row.sellerId as Id<'Seller'> | null,
    maxCount: row.maxCount,
    maxAmount: { amount: row.maxAmount, currency: row.currency },
    version: row.version,
    updatedAt: toInstant(row.updatedAt),
    updatedBy: row.updatedByAccountId as Id<'Account'>,
  };
}

interface RefundRow {
  readonly id: string;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly currency: string;
  readonly grossAmount: bigint;
  readonly taxAmount: bigint;
  readonly shippingGrossAmount: bigint;
  readonly shippingBefore: bigint;
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
            before: row.shippingBefore,
          },
    reason: row.reason as RefundReason,
    lossBearer: row.lossBearer as LossBearer,
    lossReasonCode: row.lossReasonCode as LossReasonCode | null,
    actor: {
      population: row.actorPopulation as RefundActor['population'],
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

  findTarget(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    orderId: Id<'Order'>,
  ): Promise<RefundTarget | null> {
    return this.target(market, { id: sellerOrderId, orderId });
  }

  findSellerTarget(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
  ): Promise<RefundTarget | null> {
    return this.target(market, { id: sellerOrderId, sellerId });
  }

  async listOfSellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
  ): Promise<readonly Refund[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.orderingRefund.findMany({
      where: { marketId: market.marketId, sellerOrderId, sellerId },
      include: { lines: true },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map(toRefund);
  }

  async guardSellerRefunds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    since: Temporal.Instant,
  ): Promise<SellerRefundGuard> {
    const tx = this.prisma.tx(market);
    // INSERT ... ON CONFLICT DO UPDATE: the row is made or updated, and either way locked until
    // the unit ends; a second seller refund of the same seller waits here, then counts this one.
    await tx.orderingSellerRefundGuard.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerId: { marketId: market.marketId, sellerId },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        checkedAt: toDate(at),
        lastAlertedAt: null,
        alerts: 0,
      },
      update: { checkedAt: toDate(at) },
    });
    const limits = await this.findRefundLimits(market, sellerId);
    const used = await tx.orderingRefund.aggregate({
      where: {
        marketId: market.marketId,
        sellerId,
        actorPopulation: 'seller',
        state: { not: 'failed' },
        requestedAt: { gt: toDate(since) },
      },
      _count: { _all: true },
      _sum: { grossAmount: true },
    });
    return {
      ...limits,
      usage: { count: used._count._all, amount: used._sum.grossAmount ?? 0n },
    };
  }

  async noteRefundLimitAlert(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
    since: Temporal.Instant,
  ): Promise<number | null> {
    const tx = this.prisma.tx(market);
    const made = await tx.orderingSellerRefundGuard.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          checkedAt: toDate(at),
          lastAlertedAt: toDate(at),
          alerts: 1,
        },
      ],
      skipDuplicates: true,
    });
    if (made.count === 1) return 1;
    const raised = await tx.orderingSellerRefundGuard.updateManyAndReturn({
      where: {
        marketId: market.marketId,
        sellerId,
        OR: [{ lastAlertedAt: null }, { lastAlertedAt: { lte: toDate(since) } }],
      },
      data: { lastAlertedAt: toDate(at), alerts: { increment: 1 } },
      select: { alerts: true },
    });
    return raised.length === 1 ? raised[0]!.alerts : null;
  }

  async findRefundLimits(
    market: MarketContext,
    sellerId: Id<'Seller'> | null,
  ): Promise<RefundLimits> {
    const tx = this.prisma.tx(market);
    const rows = await tx.orderingSellerRefundLimit.findMany({
      where: {
        marketId: market.marketId,
        OR: [{ sellerId: null }, ...(sellerId === null ? [] : [{ sellerId }])],
      },
      take: 2,
    });
    const own = rows.find((row) => row.sellerId !== null) ?? null;
    const marketDefault = rows.find((row) => row.sellerId === null) ?? null;
    return {
      own: own === null ? null : toLimit(own),
      marketDefault: marketDefault === null ? null : toLimit(marketDefault),
    };
  }

  async saveRefundLimit(
    market: MarketContext,
    limit: RefundLimit,
    expectedVersion: number,
  ): Promise<'saved' | 'stale'> {
    const tx = this.prisma.tx(market);
    const values = {
      maxCount: limit.maxCount,
      maxAmount: limit.maxAmount.amount,
      currency: limit.maxAmount.currency,
      updatedAt: toDate(limit.updatedAt),
      updatedByAccountId: limit.updatedBy,
    };
    if (expectedVersion === 0) {
      // ON CONFLICT DO NOTHING: a default or seller cap another admin set first is `stale`.
      const made = await tx.orderingSellerRefundLimit.createMany({
        data: [
          {
            id: limit.id,
            marketId: market.marketId,
            tenantId: market.tenantId,
            sellerId: limit.sellerId,
            version: 1,
            ...values,
          },
        ],
        skipDuplicates: true,
      });
      return made.count === 1 ? 'saved' : 'stale';
    }
    const changed = await tx.orderingSellerRefundLimit.updateMany({
      where: { marketId: market.marketId, sellerId: limit.sellerId, version: expectedVersion },
      data: { ...values, version: expectedVersion + 1 },
    });
    return changed.count === 1 ? 'saved' : 'stale';
  }

  async removeRefundLimit(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    expectedVersion: number,
  ): Promise<'removed' | 'stale'> {
    const tx = this.prisma.tx(market);
    const removed = await tx.orderingSellerRefundLimit.deleteMany({
      where: { marketId: market.marketId, sellerId, version: expectedVersion },
    });
    return removed.count === 1 ? 'removed' : 'stale';
  }

  private async target(
    market: MarketContext,
    where: {
      readonly id: Id<'SellerOrder'>;
      readonly orderId?: Id<'Order'>;
      readonly sellerId?: Id<'Seller'>;
    },
  ): Promise<RefundTarget | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.orderingSellerOrder.findFirst({
      where: { marketId: market.marketId, ...where },
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
      fulfilment: row.fulfilment as Fulfilment,
      readyAt: row.readyAt === null ? null : toInstant(row.readyAt),
      shipping: row.shippingAmount,
      shippingTax: row.shippingTaxAmount,
      shippingTaxRateBps: row.shippingTaxRateBps,
      shippingTaxInclusive: row.shippingTaxInclusive,
      total: row.totalAmount,
      refunded: row.refundedAmount,
      refundCount: row.refunds.length,
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
    options?: { readonly whileNotReady?: boolean },
  ): Promise<'saved' | 'stale'> {
    const tx = this.prisma.tx(market);
    const raised = await tx.orderingSellerOrder.updateMany({
      where: {
        marketId: market.marketId,
        id: refund.sellerOrderId,
        refundedAmount: expectedRefunded,
        ...(options?.whileNotReady === true ? { fulfilment: 'to-ship', readyAt: null } : {}),
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
        shippingBefore: refund.shipping?.before ?? 0n,
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
      include: { lines: true, sellerOrder: { include: { lines: true } } },
      orderBy: [{ ledgerAttempts: 'asc' }, { requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const found: RefundForLedger[] = [];
    for (const row of rows) {
      const seller = row.sellerOrder;
      found.push({
        refund: toRefund(row),
        freeLines: new Set(
          seller.lines.filter((l) => l.lineAmount === 0n).map((l) => l.id as Id<'OrderLine'>),
        ),
        sellerOrderLedgerState: seller.ledgerState as LedgerState,
        shippingCharge:
          seller.shippingTaxAmount === null || seller.shippingTaxInclusive === null
            ? null
            : seller.shippingAmount + (seller.shippingTaxInclusive ? 0n : seller.shippingTaxAmount),
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
