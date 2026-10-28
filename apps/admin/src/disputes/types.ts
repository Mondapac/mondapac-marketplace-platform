// Answers of GET commission-payouts/admin/disputes[/:id] and the decision route (package 8b).

export const VIEW_PERMISSION = 'commission-payouts.dispute.view';
export const ATTRIBUTE_PERMISSION = 'commission-payouts.dispute.attribute';
export const PAGE_SIZE = 25;

/**
 * Where a case is opened in Stripe's Dashboard. Test mode only for now: the live base is chosen
 * when the platform goes live. The base is the one place to change.
 */
export const STRIPE_DASHBOARD_DISPUTES = 'https://dashboard.stripe.com/test/disputes/';

export const BUCKETS = [
  'needs-response',
  'decision-needed',
  'under-review',
  'won',
  'closed',
] as const;
export type Bucket = (typeof BUCKETS)[number];

export const REASON_CODES = [
  'no-delivery-proof',
  'not-as-described',
  'card-fraud-not-seller',
  'other',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface DisputeMoney {
  /** Minor units, as a string. */
  readonly amountMinor: string;
  readonly currency: string;
}

export interface DisputeRow {
  readonly disputeId: string;
  readonly orderId: string;
  readonly sellers: readonly { readonly sellerId: string; readonly storeName: string | null }[];
  readonly reason: string;
  readonly moneyState: string;
  readonly status: string;
  readonly bucket: string;
  readonly evidenceDueBy: string | null;
  readonly amount: DisputeMoney;
  readonly openedAt: string;
}

export interface DisputePage {
  readonly counts: Readonly<Record<Bucket, number>>;
  readonly disputes: readonly DisputeRow[];
  readonly nextCursor: string | null;
}

export interface DisputeDecided {
  readonly bearer: 'platform' | 'seller';
  readonly amount: DisputeMoney | null;
  readonly reasonCode: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reversal: {
    readonly reasonCode: string;
    readonly decidedBy: string;
    readonly decidedAt: string;
  } | null;
}

export interface DisputeSellerOrder {
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly sellerShare: DisputeMoney;
  readonly recoverableCap: DisputeMoney;
  readonly holdActive: boolean;
  readonly decision: 'allowed' | 'reversal-allowed' | 'not-allowed';
  readonly decided: DisputeDecided | null;
}

export interface DisputeTimelineEntry {
  readonly kind: string;
  readonly at: string;
  readonly sellerOrderId: string | null;
}

export interface DisputeDetail {
  readonly disputeId: string;
  readonly orderId: string;
  readonly providerDisputeId: string;
  readonly amount: DisputeMoney;
  readonly status: string;
  readonly inquiry: boolean;
  readonly closed: boolean;
  readonly outcome: 'won' | 'lost' | null;
  readonly reason: string;
  readonly evidenceDueBy: string | null;
  readonly moneyState: string;
  readonly bucket: string;
  readonly needsReview: boolean;
  readonly openedAt: string;
  readonly sellerOrders: readonly DisputeSellerOrder[];
  readonly timeline: readonly DisputeTimelineEntry[];
}

export interface DecisionBody {
  readonly bearer: 'platform' | 'seller';
  readonly amountMinor?: string;
  readonly reasonCode: ReasonCode;
}
