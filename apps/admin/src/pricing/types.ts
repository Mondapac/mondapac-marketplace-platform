// Answer of GET pricing/admin/price-holds (apps/api price-hold.dto.ts). Ids, minor-unit strings
// and instants only.

export const VIEW_PERMISSION = 'pricing.price-hold.view';
export const DECIDE_PERMISSION = 'pricing.price-hold.decide';
export const REJECTION_REASONS = [
  'price-implausible',
  'price-unverified',
  'policy-breach',
  'entered-in-error',
  'other',
] as const;
export const NOTE_MAX = 1000;
export const PAGE_SIZE = 25;
/** The held-price super list route and its export (pricing `price-holds/list`, `/export`). */
export const API_HOLDS = 'pricing/admin/price-holds/list';
export const API_HOLDS_EXPORT = 'pricing/admin/price-holds/export';
export const HOLD_VIEWS = ['all', 'regular', 'special', 'up', 'down'] as const;

export interface HoldMoney {
  readonly amount: string;
  readonly currency: string;
}

export interface PriceHoldRow {
  readonly recordId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly sellerId: string;
  /** Published product name; null when it could not be read. Seller-entered text. */
  readonly productName: string | null;
  readonly variantLabel: string | null;
  /** The seller's public store name; null before approval or when it could not be read. */
  readonly storeName: string | null;
  readonly kind: 'regular' | 'special';
  /** The window a special price asked for; absent on a regular price. */
  readonly window?: { readonly startsAt: string; readonly endsAt: string };
  readonly amount: HoldMoney;
  readonly anchorAmount: HoldMoney;
  readonly direction: 'up' | 'down';
  readonly submittedAt: string;
}

export interface PriceHoldPage {
  readonly items: readonly PriceHoldRow[];
  readonly next: string | null;
}

/** One row of the super list: the held record and what this admin may do on it. */
export interface PriceHoldListRow extends PriceHoldRow {
  readonly actions: readonly ('open' | 'decide')[];
}

export type HoldCounts = Readonly<Record<(typeof HOLD_VIEWS)[number], number>>;
