import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderState } from '../domain/order';
import type { OrderingDependencies } from './checkout-flow';
import { cancelPayment } from './payment-flow';

/** How many orders one run of the sweep looks at. */
export const SWEEP_BATCH = 50;

/**
 * How long after an order's payment page expired the sweep waits before it cancels the order
 * itself. Stripe's `checkout.session.expired` normally cancels it well before this.
 */
export const SWEEP_GRACE = Temporal.Duration.from({ hours: 1 });

/** What one run of the sweep did. */
export interface RedemptionSweep {
  readonly confirmed: number;
  readonly released: number;
  readonly expired: number;
  /** Orders the sweep left alone this run: still payable, or a payment held on the card. */
  readonly waiting: number;
  /** Orders whose settlement failed; the next run tries them again. */
  readonly failed: number;
}

/**
 * `ordering.settle-stale-redemptions` (package T2): the safety net under promotions' event
 * subscriptions. promotions lists the orders that still hold RESERVED redemptions written before
 * the payment window plus {@link SWEEP_GRACE}; for each, ordering says what became of the order.
 * A confirmed order confirms them; a cancelled or unknown order releases them; a pending order
 * whose payment page expired more than the grace ago, with no payment held on the card, is
 * cancelled as `expired` (which releases its stock hold and, through `OrderCancelled`, the
 * redemptions). Every step is idempotent, so two runs at once are safe.
 *
 * The sweep lives in ordering, not promotions, because ordering already depends on promotions:
 * promotions cannot read ordering without a module cycle.
 */
export async function settleStaleRedemptions(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<RedemptionSweep, never>> {
  const now = deps.clock.now();
  const before = now.subtract({ milliseconds: deps.policy.sessionTtlMs() }).subtract(SWEEP_GRACE);
  const stale = await deps.promotions.staleRedemptions(context, { before, limit: SWEEP_BATCH });
  const counts = { confirmed: 0, released: 0, expired: 0, waiting: 0, failed: 0 };
  if (!stale.ok) return ok({ ...counts, failed: 1 });
  for (const orderId of stale.value) {
    const order = await readOrder(deps, context, orderId);
    if (order === undefined) {
      counts.failed += 1;
      continue;
    }
    if (order === null || order.status === 'cancelled' || order.status === 'confirmed') {
      const outcome = order?.status === 'confirmed' ? 'paid' : 'cancelled';
      const settled = await deps.promotions.settleRedemptions(context, { orderId, outcome });
      if (!settled.ok) counts.failed += 1;
      else if (settled.value.outcome === 'confirmed') counts.confirmed += 1;
      else if (settled.value.outcome === 'released') counts.released += 1;
      continue;
    }
    const expiredLongAgo =
      Temporal.Instant.compare(order.paymentExpiresAt.add(SWEEP_GRACE), now) < 0;
    if (!expiredLongAgo || order.paymentState !== 'none') {
      counts.waiting += 1;
      continue;
    }
    const cancelled = await cancelPayment(deps, context, { orderId, cause: 'expired' });
    if (cancelled.ok) counts.expired += 1;
    else counts.failed += 1;
  }
  return ok(counts);
}

/** The order, null when there is none, undefined when it could not be read. */
async function readOrder(
  deps: OrderingDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
): Promise<OrderState | null | undefined> {
  try {
    const read = await deps.unitOfWork.run<OrderState | null, never>(
      context.market,
      async () => ok(await deps.orders.findById(context.market, orderId)),
      { readOnly: true },
    );
    return read.ok ? read.value : undefined;
  } catch {
    return undefined;
  }
}
