import { numberFormat } from '../shared/intl.ts';

// Answers of the admin commission routes (apps/api commission-payouts.controller.ts).

export const SETTLEMENT_VIEW_PERMISSION = 'commission-payouts.settlement.view';
export const RATE_EDIT_PERMISSION = 'commission-payouts.commission-rate.edit';

/** The most a seller's own rate can be, in basis points (30 %). */
export const MAX_RATE_BPS = 3000;

export interface CommissionRate {
  readonly sellerId: string;
  /** The rate in force, in basis points (1500 = 15 %). */
  readonly rateBps: number;
  readonly source: 'seller' | 'market';
  readonly marketRateBps: number;
}

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

/** 1500 as "15", 1250 as "12.5" in the Market's locale: the percent text of a rate. */
export function percentOf(bps: number, locale: string): string {
  return numberFormat(locale, { maximumFractionDigits: 2 }).format(bps / 100);
}

/** 1500 as "15", 1250 as "12.5": the text of the rate field, always with a dot (see bpsOf). */
export function percentInput(bps: number): string {
  return String(bps / 100);
}

/** The percent text of an input ("12.5") as basis points, or null when it is not 0 to 30 %. */
export function bpsOf(text: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= MAX_RATE_BPS ? bps : null;
}
