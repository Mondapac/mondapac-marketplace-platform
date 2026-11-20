// Answers of GET commission-payouts/admin/payouts[/:id] and the approve route (package 6d).

export const VIEW_PERMISSION = 'commission-payouts.payout.view';
export const APPROVE_PERMISSION = 'commission-payouts.payout.approve';
export const PAYOUT_STATES = [
  'pending',
  'awaiting-approval',
  'approved',
  'instructing',
  'instructed',
  'paid',
  'failed',
  'not-sent',
  'voided',
  'settled-by-netting',
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export interface PayoutMoney {
  /** Minor units, as a string. */
  readonly amountMinor: string;
  readonly currency: string;
}

export interface PayoutRow {
  readonly payoutId: string;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly state: string;
  readonly gross: PayoutMoney;
  readonly netted: PayoutMoney;
  readonly transfer: PayoutMoney;
  readonly approvalMode: 'AUTO' | 'MANUAL';
  readonly approvalReason: 'first-payout' | 'terms' | null;
  readonly slotAt: string;
  readonly outcomeCode: string | null;
  readonly createdAt: string;
  readonly stateChangedAt: string;
}

export interface PayoutPage {
  readonly payouts: readonly PayoutRow[];
  readonly nextCursor: string | null;
}

export interface PayoutLimits {
  readonly perTransfer: PayoutMoney;
  readonly todayTotal: PayoutMoney;
  readonly dailyAlertLevel: PayoutMoney;
  readonly overDailyAlertLevel: boolean;
  readonly transferAboveLimit: boolean;
}

export interface PayoutDetail extends PayoutRow {
  readonly approval: {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly approvedTransfer: PayoutMoney;
  } | null;
  readonly items: readonly { readonly sellerOrderId: string; readonly amount: PayoutMoney }[];
  readonly accountReadiness: 'ready' | 'not-ready' | 'unknown';
  readonly lastBankChangeAt: string | null;
  readonly limits: PayoutLimits | null;
}

export interface Approved {
  readonly payoutId: string;
  readonly state: string;
  readonly transfer: PayoutMoney;
  readonly approvedBy: string;
  readonly approvedAt: string;
}
