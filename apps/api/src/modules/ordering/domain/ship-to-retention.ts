import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { parseVersion } from './refund-limits';

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
