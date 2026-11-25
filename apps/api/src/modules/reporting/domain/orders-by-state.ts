import { MIN_COUNT_BASE, ratioBp } from './admin-kpi';

/** Most states listed one by one; the rest are summed into `other` (a Market may have many regions). */
export const MAX_LISTED_STATES = 8;

/** The paid seller orders of a range grouped by delivery state, as the reader tallies them. */
export interface StateTallies {
  /** Every paid seller order of the range. */
  readonly paid: number;
  /** Paid orders with a recorded state, one entry per state (any order). */
  readonly states: readonly { readonly state: string; readonly orders: number }[];
}

export interface StateShare {
  readonly state: string;
  readonly orders: number;
  /** Share of all paid orders, in basis points. */
  readonly shareBp: number;
}

/**
 * Seller orders by the state they were delivered to (dashboards v2, phase 2). Delivery goes by
 * the state of the drop-off postcode and a pickup by the state of the store (set when the
 * order is recorded), so the shares add up with `unknown` (orders whose state could not be
 * read, such as those placed before delivery quotes were kept) and `other` (states beyond the
 * listed ones) to the paid orders. Below {@link MIN_COUNT_BASE} paid orders no share is shown.
 */
export type OrdersByState =
  | { readonly status: 'not-enough-data'; readonly paid: number; readonly minimum: number }
  | {
      readonly status: 'available';
      readonly paid: number;
      /** Biggest first; ties by state code. */
      readonly states: readonly StateShare[];
      /** Paid orders of the states beyond the listed ones. */
      readonly other: { readonly orders: number; readonly shareBp: number } | null;
      /** Paid orders with no state recorded. */
      readonly unknown: { readonly orders: number; readonly shareBp: number } | null;
    };

export function ordersByStateOf(tallies: StateTallies): OrdersByState {
  const { paid } = tallies;
  const known = tallies.states.reduce((sum, row) => sum + row.orders, 0);
  const counts = [paid, ...tallies.states.map((row) => row.orders)];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0) || known > paid) {
    throw new RangeError('reporting: orders by state do not add up');
  }
  if (paid < MIN_COUNT_BASE) return { status: 'not-enough-data', paid, minimum: MIN_COUNT_BASE };
  const sorted = tallies.states
    .filter((row) => row.orders > 0)
    .toSorted((a, b) => b.orders - a.orders || (a.state < b.state ? -1 : 1));
  const listed = sorted.slice(0, MAX_LISTED_STATES);
  const rest = sorted.slice(MAX_LISTED_STATES).reduce((sum, row) => sum + row.orders, 0);
  const share = (orders: number): number => ratioBp(orders, paid) ?? 0;
  return {
    status: 'available',
    paid,
    states: listed.map((row) => ({ ...row, shareBp: share(row.orders) })),
    other: rest > 0 ? { orders: rest, shareBp: share(rest) } : null,
    unknown: paid - known > 0 ? { orders: paid - known, shareBp: share(paid - known) } : null,
  };
}
