import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { OrderingDependencies } from './checkout-flow';
import { expireUnpaid } from './payment-flow';

/** How many orders one page of the sweep looks at. */
export const SWEEP_BATCH = 50;

/** At most this many pages of stale redemptions per run; the next run goes on. */
export const SWEEP_PAGES = 10;

/**
 * How long after an order's payment page expired the sweep waits before it acts. Stripe's
 * `checkout.session.expired` normally cancels the order well before this.
 */
export const SWEEP_GRACE = Temporal.Duration.from({ hours: 1 });

/** What one run of the sweep did. */
export interface RedemptionSweep {
  readonly confirmed: number;
  readonly released: number;
  readonly expired: number;
  /** Orders the sweep left alone this run: still waiting for payment, or a payment held. */
  readonly waiting: number;
  /** Orders whose settlement failed; the next run tries them again. */
  readonly failed: number;
}

/**
 * `ordering.settle-stale-redemptions` (package T2): the safety net under the payment events and
 * promotions' event subscriptions. Two passes, each idempotent, so two runs at once are safe:
 *
 * 1. Ordering's own orders still waiting for payment, with no money moved, whose payment page
 *    expired more than {@link SWEEP_GRACE} ago are cancelled as `expired` (stock released,
 *    `OrderCancelled` emitted, so promotions releases their redemptions). This covers an order
 *    that never got a payment page (a crash between the order and the redemption, a failed
 *    abandon). An order with a payment held is never touched here.
 * 2. promotions lists, page by page in order id order, the orders that still hold RESERVED
 *    redemptions written before the payment window plus the grace; ordering reads each: a
 *    confirmed order confirms them, a cancelled or unknown order releases them. One still
 *    waiting is counted and passed over, so it never blocks the orders after it.
 *
 * The sweep lives in ordering, not promotions, because ordering already depends on promotions:
 * promotions cannot read ordering without a module cycle.
 */
export async function settleStaleRedemptions(
  deps: OrderingDependencies,
  context: CallContext,
): Promise<Result<RedemptionSweep, never>> {
  const now = deps.clock.now();
  const counts = { confirmed: 0, released: 0, expired: 0, waiting: 0, failed: 0 };

  const expiredBefore = now.subtract(SWEEP_GRACE);
  const unpaid = await read(deps, context, () =>
    deps.orders.findExpiredUnpaid(context.market, expiredBefore, SWEEP_BATCH),
  );
  if (unpaid === undefined) counts.failed += 1;
  for (const orderId of unpaid ?? []) {
    const expired = await expireUnpaid(deps, context, orderId);
    if (!expired.ok) counts.failed += 1;
    else if (expired.value === 'cancelled') counts.expired += 1;
  }

  const before = now.subtract({ milliseconds: deps.policy.sessionTtlMs() }).subtract(SWEEP_GRACE);
  let after: Id<'Order'> | undefined;
  for (let page = 0; page < SWEEP_PAGES; page += 1) {
    const stale = await deps.promotions.staleRedemptions(context, {
      before,
      limit: SWEEP_BATCH,
      ...(after === undefined ? {} : { after }),
    });
    if (!stale.ok) {
      counts.failed += 1;
      break;
    }
    for (const orderId of stale.value) {
      const order = await read(deps, context, () => deps.orders.findById(context.market, orderId));
      if (order === undefined) {
        counts.failed += 1;
        continue;
      }
      if (order !== null && order.status === 'pending-payment') {
        counts.waiting += 1;
        continue;
      }
      const outcome = order?.status === 'confirmed' ? 'paid' : 'cancelled';
      const settled = await deps.promotions.settleRedemptions(context, { orderId, outcome });
      if (!settled.ok) counts.failed += 1;
      else if (settled.value.outcome === 'confirmed') counts.confirmed += 1;
      else if (settled.value.outcome === 'released') counts.released += 1;
    }
    if (stale.value.length < SWEEP_BATCH) break;
    after = stale.value[stale.value.length - 1];
  }
  return ok(counts);
}

/** A read in its own read-only unit; undefined when it could not be read. */
async function read<T>(
  deps: OrderingDependencies,
  context: CallContext,
  query: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await deps.unitOfWork.run<T, never>(
      context.market,
      async () => ok(await query()),
      { readOnly: true },
    );
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}
