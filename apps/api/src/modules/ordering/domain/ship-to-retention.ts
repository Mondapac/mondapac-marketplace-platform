import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { Fulfilment } from './order';
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
// orders were all delivered at least `months` months ago, counted back in the Market's zone
// (ADR-0005). Orders with a seller order not delivered are never touched (a decision is pending).

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

/**
 * Whether an order's sealed ship-to may be cleared: it has seller orders and every one of them was
 * delivered at or before `cutoff`. The Prisma repository repeats this rule in its query.
 */
export function isShipToPurgeable(
  sellerOrders: readonly { readonly deliveredAt: Temporal.Instant | null }[],
  cutoff: Temporal.Instant,
): boolean {
  return (
    sellerOrders.length > 0 &&
    sellerOrders.every(
      (sellerOrder) =>
        sellerOrder.deliveredAt !== null &&
        Temporal.Instant.compare(sellerOrder.deliveredAt, cutoff) <= 0,
    )
  );
}
