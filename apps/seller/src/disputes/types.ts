// Answer of GET commission-payouts/seller/disputes (package 8b). By design the route carries no
// reason, evidence date, provider id or buyer data, and this panel reads nothing else about a case.

export interface OwnDispute {
  readonly sellerOrderId: string;
  readonly orderId: string;
  /** When the dispute began to hold this seller order. */
  readonly since: string;
  /** The dispute still holds the money of this seller order. */
  readonly open: boolean;
  /** What was taken from the seller after the decision, minor units; null when nothing was. */
  readonly recoveredAmount: { readonly amountMinor: string; readonly currency: string } | null;
}

export interface OwnDisputes {
  readonly disputes: readonly OwnDispute[];
}
