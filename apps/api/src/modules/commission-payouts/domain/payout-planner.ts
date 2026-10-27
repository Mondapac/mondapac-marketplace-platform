import type { Temporal } from '@mondapac/shared-kernel';

// The payout planner (Phase 5 package 6b; G2 4.5 and 4.7 step 2): a pure function of one seller's
// ledger items, active holds, receivable balance, terms and the instant "now". It decides how much
// is eligible, how much of that the seller's receivable takes back, and how much would be
// transferred. It reads nothing and writes nothing; the payout run (package 6d) calls it outside
// any unit and creates the payout from its answer.

/** One credit the seller could be paid: a ledger amount with the instant it becomes eligible. */
export interface PlannerItem {
  readonly id: string;
  /** The seller order it belongs to, or null when it belongs to no seller order. */
  readonly sellerOrderId: string | null;
  /** Minor units of the seller's currency; an item of 0 or less is never eligible. */
  readonly amount: bigint;
  /** When it becomes eligible; null while the seller order is not yet anchored by a delivery. */
  readonly eligibleAt: Temporal.Instant | null;
}

/** An active hold: on the whole seller (`sellerOrderId` null) or on one of its seller orders. */
export interface PlannerHold {
  readonly sellerOrderId: string | null;
}

export interface PlannerInput {
  readonly items: readonly PlannerItem[];
  /** The seller's active holds only; a released hold is not passed. */
  readonly holds: readonly PlannerHold[];
  /** What the seller owes the platform, in minor units; a negative number counts as zero. */
  readonly receivable: bigint;
  /** The terms' minimum transfer, in minor units. */
  readonly minimumMinor: bigint;
  readonly now: Temporal.Instant;
}

export interface PlannerResult {
  /** E: the sum of the eligible items' amounts. */
  readonly eligible: bigint;
  /** N = min(E, R): the part of E the receivable takes back. */
  readonly netted: bigint;
  /** T = E − N: what would be transferred. */
  readonly transfer: bigint;
  /** T is above zero but under the minimum: the money carries over to a later slot. */
  readonly belowMinimum: boolean;
  /** The ids of the items counted in E, in the order given. */
  readonly eligibleItemIds: readonly string[];
  /** True when a hold on the whole seller kept every item out. */
  readonly sellerHeld: boolean;
}

const isEligible = (
  item: PlannerItem,
  now: Temporal.Instant,
  heldOrders: ReadonlySet<string>,
): boolean =>
  item.amount > 0n &&
  item.eligibleAt !== null &&
  item.eligibleAt.epochNanoseconds <= now.epochNanoseconds &&
  (item.sellerOrderId === null || !heldOrders.has(item.sellerOrderId));

/** Plans one seller's payout at `now` (see the file comment). */
export function planPayout(input: PlannerInput): PlannerResult {
  const sellerHeld = input.holds.some((hold) => hold.sellerOrderId === null);
  const heldOrders = new Set(
    input.holds.flatMap((hold) => (hold.sellerOrderId === null ? [] : [hold.sellerOrderId])),
  );
  const eligibleItems = sellerHeld
    ? []
    : input.items.filter((item) => isEligible(item, input.now, heldOrders));
  const eligible = eligibleItems.reduce((sum, item) => sum + item.amount, 0n);
  const receivable = input.receivable > 0n ? input.receivable : 0n;
  const netted = eligible < receivable ? eligible : receivable;
  const transfer = eligible - netted;
  return {
    eligible,
    netted,
    transfer,
    belowMinimum: transfer > 0n && transfer < input.minimumMinor,
    eligibleItemIds: eligibleItems.map((item) => item.id),
    sellerHeld,
  };
}
