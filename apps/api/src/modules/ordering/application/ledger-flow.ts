import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderingDependencies } from './checkout-flow';
import type { SellerOrderRecord } from './ports/order.repository';
import type { RefundForLedger } from './ports/refund.repository';

// Paid seller orders go into the seller ledger (commission-payouts, Phase 5 package 5) from the
// worker, not from the payment path: a confirmed order never waits for, or fails on, the ledger.
// commission-payouts writes each seller order once, so a repeat after a crash writes nothing. A
// refusal is counted on the seller order, and the queue takes the fewest-refused first, so one
// seller order the ledger keeps refusing never holds up the others (Hassan, package 5 review).

const LEDGER_BATCH = 20;
/** The refusals after which a seller order is reported as stuck (once, at exactly this count). */
export const LEDGER_STUCK_ATTEMPTS = 5;

export interface LedgerRecording {
  readonly recorded: number;
  readonly failed: readonly { readonly sellerOrderId: string; readonly code: string }[];
  /** Seller orders whose refusals just reached the threshold: ids, count and code only. */
  readonly stuck: readonly {
    readonly sellerOrderId: string;
    readonly attempts: number;
    readonly code: string;
  }[];
}

/** A line placed before the rate was frozen cannot be assessed: such a seller order is refused. */
function paidFacts(record: SellerOrderRecord) {
  if (record.lines.some((line) => line.commissionRateBps === null)) return null;
  return {
    orderId: record.orderId,
    sellerOrderId: record.sellerOrder.id,
    sellerId: record.sellerOrder.sellerId,
    currency: record.currency,
    shipping: record.sellerOrder.shipping,
    paidAt: record.confirmedAt,
    lines: record.lines.map((line) => ({
      orderLineId: line.id,
      lineAmount: line.lineAmount,
      taxInclusive: line.taxInclusive,
      commissionRateBps: line.commissionRateBps!,
    })),
  };
}

/** `record-ledger`: writes up to 20 paid seller orders into the seller ledger. */
export async function recordLedger(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<LedgerRecording, never>> {
  const pending = await deps.unitOfWork.run<readonly SellerOrderRecord[], never>(
    context.market,
    async () => ok(await deps.orders.findUnrecordedLedger(context.market, LEDGER_BATCH)),
    { readOnly: true },
  );
  if (!pending.ok) return pending;
  let recorded = 0;
  const failed: { sellerOrderId: string; code: string }[] = [];
  const stuck: { sellerOrderId: string; attempts: number; code: string }[] = [];
  const refuse = async (sellerOrderId: Id<'SellerOrder'>, code: string) => {
    failed.push({ sellerOrderId, code });
    const counted = await deps.unitOfWork.run<number, never>(context.market, async () =>
      ok(await deps.orders.countLedgerFailure(context.market, sellerOrderId)),
    );
    if (counted.ok && counted.value === LEDGER_STUCK_ATTEMPTS) {
      stuck.push({ sellerOrderId, attempts: counted.value, code });
    }
  };
  for (const record of pending.value) {
    const facts = paidFacts(record);
    if (facts === null) {
      await refuse(record.sellerOrder.id, 'ordering.rate-not-frozen');
      continue;
    }
    const done = await deps.commission.recordSellerOrderPaid(context, facts);
    if (!done.ok) {
      await refuse(record.sellerOrder.id, done.error.code);
      continue;
    }
    await deps.unitOfWork.run<true, never>(context.market, async () => {
      await deps.orders.markLedgerRecorded(context.market, record.sellerOrder.id);
      return ok(true as const);
    });
    recorded += 1;
  }
  return ok({ recorded, failed, stuck });
}

// Succeeded refunds go into the seller ledger the same way (Phase 5 package 6a): the worker takes
// the succeeded refunds not yet recorded, whose seller order's own paid facts are in the ledger
// (the others wait), and sends commission-payouts the ids and numbers it needs; the amounts come
// from the ledger rows there, never from a price here. Whatever the answer (rows written,
// already written, or nothing to post for a platform-borne refund), the refund is then marked
// handled. A refusal is counted on the refund and reported once at the threshold.

export interface RefundLedgerRecording {
  readonly recorded: number;
  readonly failed: readonly { readonly refundId: string; readonly code: string }[];
  /** Refunds whose refusals just reached the threshold: ids, count and code only. */
  readonly stuck: readonly {
    readonly refundId: string;
    readonly attempts: number;
    readonly code: string;
  }[];
}

/** `record-refund-ledger`: writes up to 20 succeeded refunds into the seller ledger. */
export async function recordRefundLedger(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<RefundLedgerRecording, never>> {
  const pending = await deps.unitOfWork.run<readonly RefundForLedger[], never>(
    context.market,
    async () => ok(await deps.refunds.findUnrecordedLedger(context.market, LEDGER_BATCH)),
    { readOnly: true },
  );
  if (!pending.ok) return pending;
  let recorded = 0;
  const failed: { refundId: string; code: string }[] = [];
  const stuck: { refundId: string; attempts: number; code: string }[] = [];
  const refuse = async (refundId: Id<'Refund'>, code: string) => {
    failed.push({ refundId, code });
    const counted = await deps.unitOfWork.run<number, never>(context.market, async () =>
      ok(await deps.refunds.countLedgerFailure(context.market, refundId)),
    );
    if (counted.ok && counted.value === LEDGER_STUCK_ATTEMPTS) {
      stuck.push({ refundId, attempts: counted.value, code });
    }
  };
  const handled = async (refundId: Id<'Refund'>) => {
    const at = deps.clock.now();
    await deps.unitOfWork.run<true, never>(context.market, async () => {
      await deps.refunds.markLedgerRecorded(context.market, refundId, at);
      return ok(true as const);
    });
    recorded += 1;
  };
  for (const item of pending.value) {
    const { refund } = item;
    // A seller order that never reached the ledger has nothing to reverse.
    if (item.sellerOrderLedgerState === 'not-applicable') {
      await handled(refund.id);
      continue;
    }
    if (item.sellerOrderLedgerState !== 'recorded' || refund.settledAt === null) continue;
    if (refund.shipping !== null && item.shippingCharge === null) {
      await refuse(refund.id, 'ordering.refund-shipping-unknown');
      continue;
    }
    const done = await deps.commission.recordRefund(context, {
      refundId: refund.id,
      orderId: refund.orderId,
      sellerOrderId: refund.sellerOrderId,
      sellerId: refund.sellerId,
      currency: refund.currency,
      lossBearer: refund.lossBearer,
      settledAt: refund.settledAt,
      lines: refund.lines.map((line) => ({
        orderLineId: line.orderLineId,
        lineQuantity: line.lineQuantity,
        unitsBefore: line.unitsBefore,
        units: line.quantity,
      })),
      shipping:
        refund.shipping === null
          ? null
          : {
              refundedBefore: refund.shipping.before,
              refundedAfter: refund.shipping.before + refund.shipping.gross,
              charge: item.shippingCharge!,
            },
    });
    if (!done.ok) {
      await refuse(refund.id, done.error.code);
      continue;
    }
    await handled(refund.id);
  }
  return ok({ recorded, failed, stuck });
}
