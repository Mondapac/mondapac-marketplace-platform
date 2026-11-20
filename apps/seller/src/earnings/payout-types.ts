// Answers of the seller payout routes (package 6d; apps/api commission-payouts payout.controller.ts).
// Ids, enums, minor-unit strings and instants only: the API never sends a hold id, a note, an
// admin or a transfer id to a seller.

export type ListPaging = 'pages' | 'prev-next';

export interface PayoutMoney {
  /** Minor units, as a string. */
  readonly amountMinor: string;
  readonly currency: string;
}

export const BLOCK_REASONS = [
  'below-minimum',
  'awaiting-approval',
  'account-not-ready',
  'cooling-off',
  'payouts-paused',
  'zone-missing',
  'second-factor-required',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export interface NextPayout {
  /** When the next payout is looked at; null while the store has no operating time zone. */
  readonly slotAt: string | null;
  /** The store's IANA zone. */
  readonly zone: string | null;
  /** An estimate of what would be transferred; null when nothing would. */
  readonly estimatedAmount: PayoutMoney | null;
  readonly blockReason: string | null;
}

export const PAYOUT_STATUSES = [
  'scheduled',
  'awaiting-approval',
  'on-its-way',
  'paid',
  'not-sent',
  'failed',
  'settled',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface OwnPayout {
  readonly payoutId: string;
  readonly status: string;
  readonly gross: PayoutMoney;
  /** Kept against what the seller owed. */
  readonly netted: PayoutMoney;
  readonly transfer: PayoutMoney;
  readonly slotAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: string | null;
}

/** One row of the payout list: the payout and what the row Actions menu may offer. */
export interface OwnPayoutRow extends OwnPayout {
  /** The API's row actions; today only `open`, which the panel has no page for. */
  readonly actions: readonly string[];
}

/** The seller's payouts per status, and all of them (`counts.all`). */
export type OwnPayoutCounts = Readonly<Record<'all' | PayoutStatus, number>>;

/** The answer of GET commission-payouts/seller/payouts (the Earnings super list). */
export interface OwnPayouts {
  readonly payouts: readonly OwnPayoutRow[];
  readonly counts: OwnPayoutCounts;
  /** Page numbers only; null with Previous and next. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  /** Previous and next only: names its sort, null on the last page. */
  readonly nextCursor: string | null;
}

export const HELD_REASONS = [
  'on-hold',
  'refund-pending',
  'holding-period',
  'awaiting-delivery',
] as const;

export interface OwnHeld {
  readonly sellerOrderId: string | null;
  readonly amount: PayoutMoney | null;
  readonly reason: string;
  readonly availableFrom: string | null;
}

export interface OwnHolds {
  readonly holds: readonly OwnHeld[];
}

/**
 * What the page server read for the three sections. `null` is a read that failed: that section
 * shows a retry and the others still show.
 */
export interface PayoutsInitial {
  readonly next: NextPayout | null;
  readonly holds: readonly OwnHeld[] | null;
  readonly history: OwnPayouts | null;
  /** The Market's List paging setting, read with the page. */
  readonly paging: ListPaging;
  /** The seller may open the payout account page (payments.payout-account.view). */
  readonly canOpenAccount: boolean;
}
