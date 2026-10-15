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

/** 1500 as "15", 1250 as "12.5": the percent text of a rate. */
export function percentOf(bps: number): string {
  return new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 }).format(bps / 100);
}

/** The percent text of an input ("12.5") as basis points, or null when it is not 0 to 30 %. */
export function bpsOf(text: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= MAX_RATE_BPS ? bps : null;
}
