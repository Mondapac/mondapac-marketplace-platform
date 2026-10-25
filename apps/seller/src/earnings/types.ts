// Answers of the seller ledger route (apps/api commission-payouts.controller.ts).

export const EARNINGS_VIEW_PERMISSION = 'commission-payouts.earnings.view';

/**
 * `refund-sale` and `refund-shipping` give goods and delivery fees back (debits);
 * `refund-commission` returns the commission on refunded goods (a credit); the dispute kinds are
 * a debit and its reinstatement.
 */
export type LedgerKind =
  | 'sale'
  | 'shipping'
  | 'commission'
  | 'refund-sale'
  | 'refund-shipping'
  | 'refund-commission'
  | 'dispute-debit'
  | 'dispute-reinstate';

export interface LedgerEntry {
  readonly entryId: string;
  readonly orderId: string;
  readonly kind: LedgerKind;
  readonly direction: 'credit' | 'debit';
  /** Minor units, never negative. */
  readonly amount: string;
  readonly occurredAt: string;
}

export interface Ledger {
  readonly sellerId: string;
  readonly currency: string;
  readonly totals: {
    readonly sales: string;
    readonly shipping: string;
    readonly commission: string;
    readonly refundedSales: string;
    readonly refundedShipping: string;
    readonly refundedCommission: string;
    readonly disputeDebits: string;
    readonly disputeReinstated: string;
    /** Minor units; may be negative (a refund after the money was counted). */
    readonly balance: string;
  };
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}
