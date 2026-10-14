// Answers of the seller price routes (apps/api seller-offer-prices.controller.ts,
// seller-regular-price.controller.ts). Amounts are minor units as strings.

export const PRICE_VIEW_PERMISSION = 'pricing.price.view';
export const PRICE_EDIT_PERMISSION = 'pricing.price.edit';

export interface VariantPrice {
  readonly variantId: string;
  /** What the write sends as `expectedVersion`; null while the variant has no price. */
  readonly seriesVersion: number | null;
  readonly currency: string | null;
  readonly inForce: { readonly amount: string; readonly effectiveFrom: string } | null;
  readonly held: {
    readonly amount: string;
    readonly submittedAt: string;
    readonly direction: 'up' | 'down';
  } | null;
  readonly retired: boolean;
}

export interface OfferPricesView {
  readonly offerId: string;
  readonly currency: string;
  readonly variants: readonly VariantPrice[];
}

/** `PUT .../regular-price`. */
export interface PriceWritten {
  readonly status: 'accepted' | 'pending-review' | 'unchanged';
  readonly seriesVersion: number;
  readonly recordId: string | null;
  readonly effectiveFrom: string | null;
}
