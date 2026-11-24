import { ratioBp } from './admin-kpi';
import {
  NET_REVENUE_COMPONENTS,
  NET_REVENUE_SIGN,
  type NetRevenue,
  type NetRevenueComponent,
  type NotAvailableReason,
} from './ledger';

/**
 * What the reader counts of the seller orders PAID on a day of a range (`reporting.seller_orders`
 * by `paid_day`), as they stand now. The buckets below are exclusive once {@link orderStatusOf}
 * has taken the refunded ones out.
 */
export interface OrderStatusTallies {
  readonly paid: number;
  /** Cancelled after payment (whatever else happened). */
  readonly cancelled: number;
  /** Not cancelled, delivered. */
  readonly delivered: number;
  /** Not cancelled, shipped, not delivered yet. */
  readonly shipped: number;
  /**
   * Not cancelled, with at least one succeeded refund (`reporting.refunds`), split by how far the
   * seller order got: these are taken out of the three steps above.
   */
  readonly refunded: {
    readonly delivered: number;
    readonly shipped: number;
    readonly toShip: number;
  };
}

/**
 * The admin dashboard's "Orders by status" (dashboards v2, phase 1, PR 6): every seller order
 * paid in the range in exactly one bucket, by priority cancelled > refunded > delivered > shipped
 * > to ship, so the buckets add up to `paid` (the stacked bar). Refunded means at least one
 * succeeded refund, partial or whole. Counts only.
 */
export interface OrderStatusCounts {
  readonly paid: number;
  readonly toShip: number;
  readonly shipped: number;
  readonly delivered: number;
  readonly cancelled: number;
  readonly refunded: number;
  /** Cancelled ÷ paid, basis points; null with no paid seller order. */
  readonly cancelledRateBp: number | null;
  /** Refunded ÷ paid, basis points; null with no paid seller order. */
  readonly refundedRateBp: number | null;
}

/** The exclusive buckets of the tallies. Throws when the tallies cannot be one range's. */
export function orderStatusOf(tallies: OrderStatusTallies): OrderStatusCounts {
  const { paid, cancelled, refunded } = tallies;
  const delivered = tallies.delivered - refunded.delivered;
  const shipped = tallies.shipped - refunded.shipped;
  const refundedTotal = refunded.delivered + refunded.shipped + refunded.toShip;
  const toShip = paid - cancelled - tallies.delivered - tallies.shipped - refunded.toShip;
  const all = [paid, cancelled, delivered, shipped, toShip, refunded.delivered, refunded.shipped];
  if (!all.concat(refunded.toShip).every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new RangeError('reporting: order status tallies do not add up');
  }
  return {
    paid,
    toShip,
    shipped,
    delivered,
    cancelled,
    refunded: refundedTotal,
    cancelledRateBp: ratioBp(cancelled, paid),
    refundedRateBp: ratioBp(refundedTotal, paid),
  };
}

/** By how many orders each derived bucket went below zero before it was clamped. */
export interface OrderStatusShortfall {
  readonly toShip: number;
  readonly shipped: number;
  readonly delivered: number;
}

/**
 * {@link orderStatusOf} for tallies read as separate snapshots (the dashboard's read-only unit opens
 * no transaction, ADR-0025): an order that changes state while the counts run can be counted twice
 * or not at all, so a derived bucket near zero can go negative. Such a bucket is clamped to 0 and
 * the shortfall is returned for the caller to log; the buckets then may not add up to `paid` by
 * that many orders (Mojtaba's ruling, PR 6 review). Tallies no drift explains (a negative or
 * fractional count read) still throw. A consistent set answers exactly {@link orderStatusOf}.
 */
export function orderStatusOfDrifted(tallies: OrderStatusTallies): {
  readonly counts: OrderStatusCounts;
  readonly shortfall: OrderStatusShortfall | null;
} {
  const { paid, cancelled, refunded } = tallies;
  const read = [paid, cancelled, tallies.delivered, tallies.shipped];
  const reads = read.concat(refunded.delivered, refunded.shipped, refunded.toShip);
  if (!reads.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new RangeError('reporting: order status tallies do not add up');
  }
  const delivered = tallies.delivered - refunded.delivered;
  const shipped = tallies.shipped - refunded.shipped;
  const toShip = paid - cancelled - tallies.delivered - tallies.shipped - refunded.toShip;
  const shortfall = {
    toShip: Math.max(0, -toShip),
    shipped: Math.max(0, -shipped),
    delivered: Math.max(0, -delivered),
  };
  const drifted = shortfall.toShip + shortfall.shipped + shortfall.delivered > 0;
  if (!drifted) return { counts: orderStatusOf(tallies), shortfall: null };
  const refundedTotal = refunded.delivered + refunded.shipped + refunded.toShip;
  return {
    counts: {
      paid,
      toShip: Math.max(0, toShip),
      shipped: Math.max(0, shipped),
      delivered: Math.max(0, delivered),
      cancelled,
      refunded: refundedTotal,
      cancelledRateBp: ratioBp(cancelled, paid),
      refundedRateBp: ratioBp(refundedTotal, paid),
    },
    shortfall,
  };
}

/**
 * The share of the range's paid seller orders delivered by a same-day method. It needs the
 * delivery method of each seller order in `reporting.seller_orders`, which reporting does not hold
 * yet (`not-reported`: ordering holds it on the seller order); until then it is `not-available`,
 * never 0. Same-day ÷ paid seller orders, basis points, null with none paid.
 */
export type SameDayShare =
  | {
      readonly status: 'available';
      readonly sameDay: number;
      readonly paid: number;
      readonly rateBp: number | null;
    }
  | { readonly status: 'not-available'; readonly reason: NotAvailableReason };

export function sameDayShareOf(
  source: { readonly sameDay: number; readonly paid: number } | null,
): SameDayShare {
  if (source === null) return { status: 'not-available', reason: 'not-reported' };
  return {
    status: 'available',
    sameDay: source.sameDay,
    paid: source.paid,
    rateBp: ratioBp(source.sameDay, source.paid),
  };
}

/**
 * Mondapac's take rate (dashboards v2 KPI definitions): net revenue ÷ GMV without GST, in basis
 * points. `complete` only when net revenue is complete. While a component has no source the rate
 * is `partial`: computed from the available components only (`basis`, signed as in net revenue),
 * with the `missing` ones named, so it is never shown as the take rate itself. `no-sales` when
 * the range has no GMV.
 */
export type TakeRate =
  | { readonly status: 'complete'; readonly rateBp: number }
  | {
      readonly status: 'partial';
      readonly rateBp: number;
      readonly basis: readonly NetRevenueComponent[];
      readonly missing: readonly NetRevenueComponent[];
    }
  | { readonly status: 'no-sales' };

export function takeRateOf(net: NetRevenue, gmvWithoutTax: bigint): TakeRate {
  if (gmvWithoutTax <= 0n) return { status: 'no-sales' };
  if (net.total.status === 'complete') {
    return { status: 'complete', rateBp: ratioBp(net.total.amount, gmvWithoutTax) ?? 0 };
  }
  const basis: NetRevenueComponent[] = [];
  let amount = 0n;
  for (const name of NET_REVENUE_COMPONENTS) {
    const component = net.components[name];
    if (component.status !== 'available') continue;
    basis.push(name);
    amount += NET_REVENUE_SIGN[name] * component.amount;
  }
  return {
    status: 'partial',
    rateBp: ratioBp(amount, gmvWithoutTax) ?? 0,
    basis,
    missing: net.total.missing,
  };
}
