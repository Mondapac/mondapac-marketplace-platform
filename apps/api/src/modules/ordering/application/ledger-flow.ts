import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderingDependencies } from './checkout-flow';
import type { SellerOrderRecord } from './ports/order.repository';

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
