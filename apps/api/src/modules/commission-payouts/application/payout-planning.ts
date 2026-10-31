import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import { planPayout, type PlannerItem, type PlannerResult } from '../domain/payout-planner';
import type { BlockReason, PayoutItem } from '../domain/payout';
import type { PayoutDependencies } from './payout-dependencies';

// Working out what one seller would be paid (package 6d; G2 4.5, 4.7 step 2). The items are the
// seller's delivered seller orders that are worth something now and are in no payout that has not
// ended without paying; the receivable is what the seller owes the platform. Both come from this
// module's own tables: the ledger (what each seller order is worth), the payouts (what was taken)
// and the eligibility anchors (when each becomes eligible).

export const HOLDS_READ_LIMIT = 1000;

/** The part of a seller's position the planner needs, read through the caller's open unit. */
export interface SellerPlan {
  readonly plan: PlannerResult;
  /** The seller orders counted in `plan.eligible`, with what each is worth. */
  readonly items: readonly PayoutItem[];
  /** Whether the seller has ever been paid (a PAID payout). */
  readonly hasPaid: boolean;
  /** What the seller owes the platform now, minor units. */
  readonly receivable: bigint;
}

/**
 * Plans the seller's payout as of `at`. Reads only; call it inside a unit (a read-only one for a
 * look, the seller's own unit after it holds the cursor lock for a decision).
 */
export async function planSeller(
  deps: PayoutDependencies,
  market: MarketContext,
  sellerId: Id<'Seller'>,
  currency: string,
  minimumMinor: bigint,
  at: Temporal.Instant,
): Promise<SellerPlan> {
  const nets = await deps.ledger.netBySellerOrder(market, sellerId, currency);
  const position = await deps.payouts.position(market, sellerId);

  let owed = 0n;
  for (const { sellerOrderId, net } of nets) {
    const shortfall = (position.takenAmounts.get(sellerOrderId) ?? 0n) - net;
    if (shortfall > 0n) owed += shortfall;
  }
  const receivable = owed > position.nettedTotal ? owed - position.nettedTotal : 0n;

  const candidates = nets.filter(
    ({ sellerOrderId, net }) => net > 0n && !position.itemAmounts.has(sellerOrderId),
  );
  const anchors = await deps.anchors.findMany(
    market,
    candidates.map((candidate) => candidate.sellerOrderId),
  );
  const eligibleAt = new Map(anchors.map((anchor) => [anchor.sellerOrderId, anchor.eligibleAt]));
  const items: PlannerItem[] = candidates.map(({ sellerOrderId, net }) => ({
    id: sellerOrderId,
    sellerOrderId,
    amount: net,
    eligibleAt: eligibleAt.get(sellerOrderId) ?? null,
  }));
  const holds = await deps.holds.listForSeller(market, sellerId, {
    activeOnly: true,
    limit: HOLDS_READ_LIMIT,
  });
  const plan = planPayout({
    items,
    holds: holds.map((hold) => ({ sellerOrderId: hold.sellerOrderId })),
    receivable,
    minimumMinor,
    now: at,
  });
  const counted = new Set(plan.eligibleItemIds);
  return {
    plan,
    items: candidates
      .filter(({ sellerOrderId }) => counted.has(sellerOrderId))
      .map(({ sellerOrderId, net }) => ({ sellerOrderId, amount: net })),
    hasPaid: position.hasPaid,
    receivable,
  };
}

export type GateAnswer =
  | { readonly kind: 'open' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason }
  | { readonly kind: 'unavailable' };

/**
 * The checks that must pass before money goes to the seller (design 4.6): the seller may sell
 * (approved, not suspended), Stripe can pay the seller's account, and the prerequisites that have
 * a source. Every answer comes from another module, so none of this runs inside a unit; an answer
 * that is not a clear one is `unavailable` and nothing is decided on it.
 */
export async function gateSeller(
  deps: PayoutDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<GateAnswer> {
  const eligible = await deps.access.eligible(context, [sellerId]);
  if (eligible === 'unavailable') return { kind: 'unavailable' };
  if (eligible.get(sellerId) !== true) return { kind: 'blocked', reason: 'payouts-paused' };

  const ready = await deps.payments.readiness(context, [sellerId]);
  if (ready === 'unavailable') return { kind: 'unavailable' };
  if (ready.get(sellerId) !== true) return { kind: 'blocked', reason: 'account-not-ready' };

  const prerequisites = await deps.prerequisites.check(context, sellerId);
  if (prerequisites === 'unavailable') return { kind: 'unavailable' };
  if (prerequisites === 'second-factor-required') {
    return { kind: 'blocked', reason: 'second-factor-required' };
  }
  return { kind: 'open' };
}

/** The start of "today" in the Market's zone, for the day's total against the alert level. */
export function startOfMarketDay(zone: string, now: Temporal.Instant): Temporal.Instant {
  return now.toZonedDateTimeISO(zone).startOfDay().toInstant();
}
