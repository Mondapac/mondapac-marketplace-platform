import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { Fulfilment, OrderStatus } from './order';
import { linesRefundedInFull, type RefundState } from './refund';
import { parseVersion } from './refund-limits';

/**
 * How long after a seller order is delivered its seller may still read the customer's delivery
 * address and phone (and the note the customer wrote to it, which travels with the address).
 * Owner decision of 14 Nov 2026: 30 days, the same in every Market. A per-Market setting is a
 * later option; until then this is the one place the period lives. Expressed in hours because a
 * Temporal.Instant only adds exact units.
 */
export const SELLER_SHIP_TO_RETENTION = Temporal.Duration.from({ hours: 30 * 24 });

/**
 * How long after a seller order was shipped, when it was never recorded delivered, its seller may
 * still read the address, phone and note. Owner decision of 15 Nov 2026: 60 days, the same in
 * every Market. A per-Market setting is a later option, as for {@link SELLER_SHIP_TO_RETENTION}.
 */
export const SELLER_SHIP_TO_RETENTION_UNDELIVERED = Temporal.Duration.from({ hours: 60 * 24 });

/** What the retention rule reads of one seller order. */
export interface ShipToRetentionFacts {
  readonly fulfilment: Fulfilment;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /**
   * The order was cancelled, or every unit of the seller order is refunded by refunds that have
   * not failed: nothing is left to send.
   */
  readonly cancelledOrRefundedInFull: boolean;
}

/**
 * Whether the seller may still see where its order goes (owner decisions of 14 and 15 Nov 2026):
 * - cancelled or refunded in full: never, from that moment on;
 * - delivered: until `deliveredAt + 30 days` (for a pickup order, the moment it was collected);
 * - shipped, not delivered: until `shippedAt + 60 days`;
 * - not shipped yet: always.
 * At the limit itself the address is withheld.
 */
export function sellerMaySeeShipTo(facts: ShipToRetentionFacts, now: Temporal.Instant): boolean {
  if (facts.cancelledOrRefundedInFull) return false;
  const before = (limit: Temporal.Instant) => Temporal.Instant.compare(now, limit) < 0;
  // The database CHECK `ordering.seller_orders_fulfilment_fields_check` (migration
  // 20261027011000_ordering_pickup_codes) makes `shipped` carry `shipped_at`, and `delivered`
  // carry both instants, so a missing instant cannot be stored. Should one reach here anyway,
  // the address is withheld (fail closed) rather than shown for ever.
  switch (facts.fulfilment) {
    case 'to-ship':
      return true;
    case 'shipped':
      return (
        facts.shippedAt !== null &&
        before(facts.shippedAt.add(SELLER_SHIP_TO_RETENTION_UNDELIVERED))
      );
    case 'delivered':
      return facts.deliveredAt !== null && before(facts.deliveredAt.add(SELLER_SHIP_TO_RETENTION));
  }
}

// How long the sealed ship-to of a delivered order is kept (owner decision 2026-11-15): an admin
// setting per Market, off by default because the deletion is irreversible. When on, a daily job
// clears the sealed delivery address (address, phone, buyer note) of every order whose seller
// orders are all settled, the last of them at least `months` months ago, counted back in the
// Market's zone (ADR-0005). Settled (owner decision 2026-11-15, 03:42Z): delivered, shipped and
// never delivered, cancelled with the order, or refunded in full by succeeded refunds while still
// to ship. A to-ship seller order that is neither cancelled nor so refunded is never settled.

/** The fewest and most months an admin may set (and the database CHECK). */
export const MIN_SHIP_TO_RETENTION_MONTHS = 1;
export const MAX_SHIP_TO_RETENTION_MONTHS = 120;
/** How many orders one unit of the purge job clears at most. */
export const SHIP_TO_PURGE_BATCH = 500;

/** What a Market without a row has: off, 24 months. */
export const DEFAULT_SHIP_TO_RETENTION = Object.freeze({ enabled: false, months: 24 });

/** The stored setting of one Market. */
export interface ShipToRetention {
  readonly id: Id<'ShipToRetentionSetting'>;
  readonly enabled: boolean;
  readonly months: number;
  /** 1 when first set, +1 on each change; a stale edit is refused. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: Id<'Account'>;
}

/** An admin's setting as asked, with the version read (0 when no row exists yet). */
export interface ShipToRetentionInput {
  readonly enabled: boolean;
  readonly months: number;
  readonly expectedVersion: number;
}

type Fields = readonly { readonly path: string; readonly code: string }[];

/** Reads `{ enabled, months, expectedVersion }`: a boolean, a whole number of 1 to 120, a version. */
export function parseShipToRetentionInput(input: {
  readonly enabled: unknown;
  readonly months: unknown;
  readonly expectedVersion: unknown;
}):
  | { readonly ok: true; readonly value: ShipToRetentionInput }
  | { readonly ok: false; readonly fields: Fields } {
  const fields: { path: string; code: string }[] = [];
  const enabled = input?.enabled;
  if (typeof enabled !== 'boolean') fields.push({ path: 'enabled', code: 'type' });
  const months = input?.months;
  const monthsOk =
    typeof months === 'number' &&
    Number.isSafeInteger(months) &&
    months >= MIN_SHIP_TO_RETENTION_MONTHS &&
    months <= MAX_SHIP_TO_RETENTION_MONTHS;
  if (!monthsOk) fields.push({ path: 'months', code: 'range' });
  const version = parseVersion(input?.expectedVersion);
  if (version === null) fields.push({ path: 'expectedVersion', code: 'range' });
  if (fields.length > 0 || version === null) return { ok: false, fields };
  return {
    ok: true,
    value: { enabled: enabled as boolean, months: months as number, expectedVersion: version },
  };
}

/**
 * The latest delivery instant whose ship-to may be cleared: `now` less `months` calendar months in
 * `zone` (a month end clamps, as Temporal does: 31 March less one month is the end of February).
 */
export function shipToRetentionCutoff(
  now: Temporal.Instant,
  zone: string,
  months: number,
): Temporal.Instant {
  return now.toZonedDateTimeISO(zone).subtract({ months }).toInstant();
}

/** What the purge rule reads of one order: its state and each seller order with its refunds. */
export interface ShipToSettlementFacts {
  readonly status: OrderStatus;
  /** Set exactly when the order is cancelled (database CHECK `orders_cancel_reason_check`). */
  readonly cancelledAt: Temporal.Instant | null;
  readonly sellerOrders: readonly {
    readonly fulfilment: Fulfilment;
    readonly shippedAt: Temporal.Instant | null;
    readonly deliveredAt: Temporal.Instant | null;
    readonly lines: readonly { readonly lineId: Id<'OrderLine'>; readonly quantity: number }[];
    /** Every refund of the seller order; only succeeded ones count for the purge. */
    readonly refunds: readonly {
      readonly state: RefundState;
      /** When Stripe's answer settled it; null while pending (database CHECK `refunds_state_check`). */
      readonly settledAt: Temporal.Instant | null;
      readonly lines: readonly {
        readonly orderLineId: Id<'OrderLine'>;
        readonly quantity: number;
      }[];
    }[];
  }[];
}

type SettlementSellerOrder = ShipToSettlementFacts['sellerOrders'][number];

/**
 * The instant the succeeded refunds first gave back every unit of a seller order, taking them in
 * the order Stripe settled them: the `settledAt` of the refund that completed it. Stricter than
 * the seller visibility rule (which counts every refund not failed, {@link linesRefundedInFull}):
 * a pending refund may still fail, and the buyer would then be owed goods with no address left
 * (Hassan, PR #883). Pending and failed refunds never settle a seller order here. Null when the
 * succeeded refunds do not cover every unit.
 */
function refundedInFullAt(sellerOrder: SettlementSellerOrder): Temporal.Instant | null {
  const succeeded = sellerOrder.refunds
    .filter(
      (refund): refund is typeof refund & { readonly settledAt: Temporal.Instant } =>
        refund.state === 'succeeded' && refund.settledAt !== null,
    )
    .sort((a, b) => Temporal.Instant.compare(a.settledAt, b.settledAt));
  for (let n = 1; n <= succeeded.length; n += 1) {
    // Every refund passed is succeeded, so "not failed" here means "succeeded".
    if (linesRefundedInFull(sellerOrder.lines, succeeded.slice(0, n))) {
      return succeeded[n - 1]!.settledAt;
    }
  }
  return null;
}

/**
 * When a seller order was settled, or null while it is not:
 * - the order is cancelled: the order's cancellation instant;
 * - delivered: `deliveredAt`;
 * - shipped and never delivered: `shippedAt`;
 * - still to ship and refunded in full by succeeded refunds: the `settledAt` of the one that
 *   completed it (pending and failed refunds do not count);
 * - any other to-ship seller order: never settled.
 * A missing instant the database CHECKs rule out answers null (fail closed: nothing is deleted).
 */
export function sellerOrderSettledAt(
  order: Pick<ShipToSettlementFacts, 'status' | 'cancelledAt'>,
  sellerOrder: SettlementSellerOrder,
): Temporal.Instant | null {
  if (order.status === 'cancelled') return order.cancelledAt;
  switch (sellerOrder.fulfilment) {
    case 'delivered':
      return sellerOrder.deliveredAt;
    case 'shipped':
      return sellerOrder.shippedAt;
    case 'to-ship':
      return refundedInFullAt(sellerOrder);
  }
}

/**
 * Whether an order's sealed ship-to may be cleared: it has seller orders, every one of them is
 * settled ({@link sellerOrderSettledAt}), and the latest settling instant is at or before `cutoff`.
 * The Prisma repository narrows its candidates with a query and then decides with this function,
 * so the rule lives here only.
 */
export function isShipToPurgeable(facts: ShipToSettlementFacts, cutoff: Temporal.Instant): boolean {
  if (facts.sellerOrders.length === 0) return false;
  return facts.sellerOrders.every((sellerOrder) => {
    const settledAt = sellerOrderSettledAt(facts, sellerOrder);
    return settledAt !== null && Temporal.Instant.compare(settledAt, cutoff) <= 0;
  });
}
