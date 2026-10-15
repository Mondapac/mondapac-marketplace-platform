// Answers of the seller ledger route (apps/api commission-payouts.controller.ts).

export const EARNINGS_VIEW_PERMISSION = 'commission-payouts.earnings.view';

export type LedgerKind = 'sale' | 'shipping' | 'commission';

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
    readonly balance: string;
  };
  readonly entries: readonly LedgerEntry[];
  readonly nextCursor: string | null;
}
