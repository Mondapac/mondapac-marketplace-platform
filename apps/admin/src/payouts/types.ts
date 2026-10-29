// Answers of GET commission-payouts/admin/payouts[/:id] and the approve route (package 6d).

export const VIEW_PERMISSION = 'commission-payouts.payout.view';
export const APPROVE_PERMISSION = 'commission-payouts.payout.approve';
export const PAGE_SIZE = 25;
/** The most the API returns on a page; the tab counts read one page of this size. */
export const COUNT_PAGE_SIZE = 100;

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

/**
 * The list tabs and the API states each one reads. The API filters by one state, so "Sending" is
 * three reads merged. A voided payout never happened and a payout settled by netting sent no
 * transfer; neither has a tab.
 */
export const TABS = ['awaiting-approval', 'sending', 'paid', 'failed', 'not-sent'] as const;
export type Tab = (typeof TABS)[number];
export const TAB_STATES: Readonly<Record<Tab, readonly PayoutState[]>> = {
  'awaiting-approval': ['awaiting-approval'],
  sending: ['approved', 'instructing', 'instructed'],
  paid: ['paid'],
  failed: ['failed'],
  'not-sent': ['not-sent'],
};

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
  /**
   * The end of the waiting period after a bank-account change. The API does not send it yet
   * (docs/modules/commission-payouts/notes.md, open item 2); a row without it shows no waiting.
   */
  readonly coolingOffUntil?: string | null;
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

/** The end of a bank-change waiting period that has not passed yet, or null. */
export function bankWaitUntil(
  row: { readonly coolingOffUntil?: string | null },
  now: number,
): string | null {
  const until = row.coolingOffUntil;
  if (until === undefined || until === null) return null;
  const ms = Date.parse(until);
  return Number.isNaN(ms) || ms <= now ? null : until;
}
