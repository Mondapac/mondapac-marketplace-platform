import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { LossBearer, LossReasonCode } from './reason-codes';
import type { OrderCustomerView } from './order-views';
import type { RefundReason, RefundState } from './refund';

// The admin Refunds list (panel menu v2, Sales > Refunds; a super list, CLAUDE.md rule 14): every
// refund of the Market, one row per refund, whatever the order. It only reads `ordering.refunds`
// and the order it belongs to; it never changes a refund.

/** The row actions the server allows, so the panel's Actions menu matches the server. */
export const REFUND_ROW_ACTIONS = ['view-order', 'copy-stripe-reference'] as const;
export type RefundRowAction = (typeof REFUND_ROW_ACTIONS)[number];

/** `waiting`: succeeded but not yet in the seller ledger; `recorded`: in it (or needed no rows). */
export type RefundLedgerFilter = 'waiting' | 'recorded';

export const REFUND_SORT_KEYS = ['requested', 'settled', 'amount'] as const;
export type RefundSortKey = (typeof REFUND_SORT_KEYS)[number];

/** Where a Previous/Next page starts: after this refund, newest request first. */
export interface RefundCursor {
  readonly requestedAt: Temporal.Instant;
  readonly refundId: Id<'Refund'>;
}

export interface RefundSort {
  readonly key: RefundSortKey;
  readonly direction: 'asc' | 'desc';
}

/** Every field is an AND; null leaves it out. */
export interface RefundListFilter {
  readonly state: RefundState | null;
  /** An id the admin pasted: the refund's, its order's or its seller order's. */
  readonly reference: string | null;
  /** A Stripe refund id (`re_…`), exact. */
  readonly stripeRefundId: string | null;
  readonly reason: RefundReason | null;
  readonly actor: 'admin' | 'seller' | null;
  readonly lossBearer: LossBearer | null;
  readonly ledger: RefundLedgerFilter | null;
  readonly sellerId: Id<'Seller'> | null;
  /** Requested at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  /** Gross in minor units of the Market's currency, both ends included. */
  readonly minAmount: bigint | null;
  readonly maxAmount: bigint | null;
  /**
   * The search, resolved by the owning modules: a refund matches when its customer or its store
   * does. Null without a search; empty lists match nothing.
   */
  readonly parties: {
    readonly accountIds: readonly Id<'Account'>[];
    readonly sellerIds: readonly Id<'Seller'>[];
  } | null;
}

/** One refund as the list reads it. */
export interface RefundListRecord {
  readonly refundId: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  /** The order's customer account (for the name lookup only). */
  readonly accountId: Id<'Account'>;
  readonly gross: Money;
  readonly tax: Money;
  readonly shippingGross: Money;
  readonly reason: RefundReason;
  readonly actor: 'admin' | 'seller';
  readonly state: RefundState;
  readonly lossBearer: LossBearer;
  readonly lossReasonCode: LossReasonCode | null;
  readonly stripeRefundId: string | null;
  readonly requestedAt: Temporal.Instant;
  readonly settledAt: Temporal.Instant | null;
  readonly ledgerRecordedAt: Temporal.Instant | null;
  /** The credit note of a succeeded refund; null otherwise. */
  readonly creditNoteId: Id<'CreditNote'> | null;
}

/** The Market's refunds per state, whatever the filter: the counts on the list's tabs. */
export interface RefundStateCounts {
  readonly pending: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface RefundListRow extends RefundListRecord {
  /** Null when the store's name could not be read. */
  readonly storeName: string | null;
  /** Null when the admin may not see customers or the lookup failed. PERSONAL DATA. */
  readonly customer: OrderCustomerView | null;
  readonly actions: readonly RefundRowAction[];
}

export interface RefundListPage {
  readonly rows: readonly RefundListRow[];
  readonly counts: RefundStateCounts;
  /**
   * Page numbers (List paging `pages`): the total, the page and its size. Previous/Next
   * (`prev-next`, or past row 10,000): total and page are null and `nextCursor` leads on.
   */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
  readonly searchScope: 'customers-and-stores' | 'stores' | null;
}

/**
 * The row actions of one refund. Every admin who can read the list can open the order (same view
 * key); the Stripe reference exists only once Stripe made the refund. Refunding again and
 * cancelling live on the order page, behind their own keys, never in this list.
 */
export function refundRowActions(record: RefundListRecord): readonly RefundRowAction[] {
  const actions: RefundRowAction[] = ['view-order'];
  if (record.stripeRefundId !== null) actions.push('copy-stripe-reference');
  return actions;
}
