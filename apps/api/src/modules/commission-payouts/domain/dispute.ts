import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { LedgerEntry } from './ledger';

// Dispute effects (Phase 5 package 8b; docs/design/domain/commission-payouts.md 4.10). A dispute
// case is a snapshot of payments' dispute; an open case holds the money of the order's seller
// orders; a lost chargeback is decided by an admin per seller order (D5): the platform bears it
// (the default, no ledger row) or the seller repays up to its unreversed share (a `dispute-debit`).
// Nothing here moves money by itself: the bank withdrawing or returning funds changes the case and
// the hold, never the seller ledger.

/** Stripe's dispute statuses; `warning_*` is an inquiry. */
export const DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** The admin list's buckets. */
export const DISPUTE_BUCKETS = [
  'needs-response',
  'decision-needed',
  'under-review',
  'won',
  'closed',
] as const;
export type DisputeBucket = (typeof DISPUTE_BUCKETS)[number];

/** What the money of a case is doing now (the admin list's money column). */
export type DisputeMoneyState = 'withdrawn' | 'inquiry' | 'reinstated' | 'none';

export const DECISION_BEARERS = ['platform', 'seller'] as const;
export type DecisionBearer = (typeof DECISION_BEARERS)[number];

/** Why an admin decided as they did; a closed list, never free text. */
export const DECISION_REASON_CODES = [
  'no-delivery-proof',
  'not-as-described',
  'card-fraud-not-seller',
  'other',
] as const;
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export interface DisputeCase {
  readonly disputeId: Id<'Dispute'>;
  readonly orderId: Id<'Order'>;
  /** Stripe's dispute id, for the Dashboard link; never shown to a seller. */
  readonly providerDisputeId: string;
  readonly amount: Money;
  readonly status: DisputeStatus;
  readonly inquiry: boolean;
  readonly closed: boolean;
  readonly outcome: 'won' | 'lost' | null;
  /** Stripe's reason code; admin-only. */
  readonly reason: string;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Temporal.Instant | null;
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Temporal.Instant | null;
  readonly openedAt: Temporal.Instant;
  /** When this module first saw the case closed. */
  readonly closedAt: Temporal.Instant | null;
  readonly bucket: DisputeBucket;
  readonly lastSyncedVersion: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** One admin decision on one seller order of a case. Insert-only. */
export interface DisputeDecision {
  readonly id: Id<'DisputeDecision'>;
  readonly disputeId: Id<'Dispute'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly bearer: DecisionBearer;
  /** Set only when the seller bears it. */
  readonly amount: Money | null;
  readonly reasonCode: DecisionReasonCode;
  readonly decidedBy: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  /** The seller decision this one reverses (platform after seller, in needs-review only). */
  readonly supersedes: Id<'DisputeDecision'> | null;
}

/** A lost chargeback whose money the bank later returned: an admin case, never netted. */
export const needsReview = (c: Pick<DisputeCase, 'closed' | 'outcome' | 'fundsReinstated'>) =>
  c.closed && c.outcome === 'lost' && c.fundsReinstated;

export function moneyStateOf(
  c: Pick<DisputeCase, 'fundsWithdrawn' | 'fundsReinstated' | 'inquiry'>,
): DisputeMoneyState {
  if (c.fundsReinstated) return 'reinstated';
  if (c.fundsWithdrawn) return 'withdrawn';
  if (c.inquiry) return 'inquiry';
  return 'none';
}

/** The decisions of one seller order of one case: the first and its reversal, if any. */
export interface SellerOrderDecision {
  readonly first: DisputeDecision;
  readonly reversal: DisputeDecision | null;
}

export function decisionsBySellerOrder(
  decisions: readonly DisputeDecision[],
): ReadonlyMap<Id<'SellerOrder'>, SellerOrderDecision> {
  const map = new Map<Id<'SellerOrder'>, SellerOrderDecision>();
  for (const d of decisions) {
    if (d.supersedes === null) map.set(d.sellerOrderId, { first: d, reversal: null });
  }
  for (const d of decisions) {
    if (d.supersedes === null) continue;
    const found = map.get(d.sellerOrderId);
    if (found !== undefined && found.first.id === d.supersedes) {
      map.set(d.sellerOrderId, { first: found.first, reversal: d });
    }
  }
  return map;
}

/** What the seller repaid for the seller order: a seller decision that nothing has reversed. */
export function recoveredOf(decision: SellerOrderDecision | undefined): Money | null {
  if (decision === undefined || decision.reversal !== null) return null;
  return decision.first.bearer === 'seller' ? decision.first.amount : null;
}

/**
 * The bucket of a case. `needs-response` and `under-review` are open cases by Stripe's status;
 * `decision-needed` is a lost chargeback with a seller order still undecided, or one the bank later
 * reinstated while a seller still repays (needs review); `won`; `closed` is everything else.
 */
export function bucketOf(
  c: Pick<DisputeCase, 'status' | 'closed' | 'outcome' | 'fundsReinstated'>,
  sellerOrderIds: readonly Id<'SellerOrder'>[],
  decisions: ReadonlyMap<Id<'SellerOrder'>, SellerOrderDecision>,
): DisputeBucket {
  if (!c.closed) {
    return c.status === 'under_review' || c.status === 'warning_under_review'
      ? 'under-review'
      : 'needs-response';
  }
  if (c.outcome === 'won') return 'won';
  if (c.outcome === 'lost') {
    const undecided = sellerOrderIds.some((id) => !decisions.has(id));
    const repaying =
      c.fundsReinstated && [...decisions.values()].some((d) => recoveredOf(d) !== null);
    if (undecided || repaying) return 'decision-needed';
  }
  return 'closed';
}

/**
 * Whether the dispute holds go. Only a closed case releases: a won chargeback, a closed inquiry
 * (`warning_closed`, `prevented`), or a lost one once every seller order has a decision.
 */
export function releasable(
  c: Pick<DisputeCase, 'closed' | 'outcome'>,
  sellerOrderIds: readonly Id<'SellerOrder'>[],
  decisions: ReadonlyMap<Id<'SellerOrder'>, SellerOrderDecision>,
): boolean {
  if (!c.closed) return false;
  if (c.outcome === 'lost') return sellerOrderIds.every((id) => decisions.has(id));
  return true;
}

export type DecisionRefusal =
  'commission-payouts.dispute.not-decidable' | 'commission-payouts.dispute.already-decided';

/**
 * Whether an admin may decide now, and how. A first decision needs a lost chargeback. A second one
 * is allowed only in needs-review, only seller to platform, once (it reverses the recovery).
 */
export function decisionRule(
  c: Pick<DisputeCase, 'closed' | 'outcome' | 'fundsReinstated'>,
  existing: SellerOrderDecision | undefined,
  bearer: DecisionBearer,
):
  | { readonly ok: true; readonly kind: 'new' | 'reverse' }
  | { readonly ok: false; readonly code: DecisionRefusal } {
  if (!c.closed || c.outcome !== 'lost') {
    return { ok: false, code: 'commission-payouts.dispute.not-decidable' };
  }
  if (existing === undefined) return { ok: true, kind: 'new' };
  if (
    needsReview(c) &&
    existing.first.bearer === 'seller' &&
    existing.reversal === null &&
    bearer === 'platform'
  ) {
    return { ok: true, kind: 'reverse' };
  }
  return { ok: false, code: 'commission-payouts.dispute.already-decided' };
}

/** The kinds that make up a seller's share of a seller order (the cap's basis). */
const SHARE_PLUS = new Set(['sale', 'shipping', 'refund-commission']);
const SHARE_MINUS = new Set(['commission', 'refund-sale', 'refund-shipping']);

/**
 * A seller order's unreversed share: sale, shipping and the commission given back, less commission
 * and the refunded parts. May be negative after refunds.
 */
export function sellerShareOf(entries: readonly LedgerEntry[]): bigint {
  let share = 0n;
  for (const e of entries) {
    if (SHARE_PLUS.has(e.kind)) share += e.amount.amount;
    else if (SHARE_MINUS.has(e.kind)) share -= e.amount.amount;
  }
  return share;
}

/** What disputes already took from the seller order (debits less reinstated credits). */
export function disputeRecoveredOf(entries: readonly LedgerEntry[]): bigint {
  let taken = 0n;
  for (const e of entries) {
    if (e.kind === 'dispute-debit') taken += e.amount.amount;
    else if (e.kind === 'dispute-reinstate') taken -= e.amount.amount;
  }
  return taken;
}

/**
 * The most that may be recovered from the seller on this seller order (Q-O4): its unreversed share
 * less what disputes already took, never below zero. Commission is not reversed.
 */
export function recoverableCap(entries: readonly LedgerEntry[]): bigint {
  const left = sellerShareOf(entries) - disputeRecoveredOf(entries);
  return left > 0n ? left : 0n;
}
