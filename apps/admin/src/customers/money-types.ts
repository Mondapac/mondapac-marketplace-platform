// Customers phase 2b, part A: the answers of the Money tab's lists (payments and disputes from
// payments, refunds from ordering, promotion usages from promotions). Money is minor units as
// digits with the currency; instants are ISO 8601.

export interface MoneyAmount {
  readonly amount: string;
  readonly currency: string;
}

/** The page of a super list read (the platform's list answer). */
export interface ListAnswer<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  /** Rows over all pages; null in `prev-next` mode (never counted). */
  readonly total: number | null;
  readonly hasNext: boolean;
}

/** The deepest row the lists reach (the API's page cap); narrow the filter for more. */
export const MONEY_MAX_ROWS = 10_000;

export interface PaymentRow {
  readonly orderId: string;
  readonly status: string;
  readonly paymentState: string;
  readonly amount: MoneyAmount;
  /** Stripe's PaymentIntent id (pi_...), or null before one exists. */
  readonly providerPaymentId: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

/** POST payments/admin/customers/:id/payments: `paid` is one gross captured sum per currency. */
export interface PaymentsAnswer extends ListAnswer<PaymentRow> {
  readonly paid: readonly MoneyAmount[];
}

export interface DisputeRow {
  readonly disputeId: string;
  readonly orderId: string;
  readonly status: string;
  readonly reason: string;
  readonly amount: MoneyAmount;
  readonly openedAt: string;
  readonly evidenceDueBy: string | null;
  readonly outcome: 'won' | 'lost' | null;
}

export interface RefundRow {
  readonly refundId: string;
  readonly orderId: string;
  readonly sellerOrderId: string;
  readonly state: string;
  readonly reason: string;
  readonly amount: MoneyAmount;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly creditNoteId: string | null;
}

/** GET promotions/admin/customers/:id/usages. */
export interface PromotionUsage {
  readonly id: string;
  readonly orderId: string;
  readonly kind: string;
  readonly promotionId: string | null;
  /** Null for a settings-based offer (first order, free shipping). */
  readonly promotionName: string | null;
  readonly amountMinor: string;
  readonly currency: string;
  /** Whether a code was typed; the code itself is never sent. */
  readonly usedCode: boolean;
  readonly status: string;
  readonly releaseReason: string | null;
  /** The reservation instant. */
  readonly usedAt: string;
  readonly confirmedAt: string | null;
  readonly releasedAt: string | null;
}

export interface PromotionUsages {
  readonly items: readonly PromotionUsage[];
  readonly nextCursor: string | null;
}
