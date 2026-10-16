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
  readonly kind: 'regular';
  readonly amount: HoldMoney;
  readonly anchorAmount: HoldMoney;
  readonly direction: 'up' | 'down';
  readonly submittedAt: string;
}

export interface PriceHoldPage {
  readonly items: readonly PriceHoldRow[];
  readonly next: string | null;
}
