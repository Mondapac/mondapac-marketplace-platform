import type { Availability } from './stock';

// The per-customer cap of one line (inventory design 5.1, Q11, Q-O1, Hassan finding 1). Computed
// only from public data: the Offer's limit, or the public status and `onlyLeft`, so a refusal
// reveals nothing above the low-stock threshold.

export interface CapInput {
  /** The seller's `OfferPurchaseLimit` for the Offer, or null. */
  readonly purchaseLimit: number | null;
  /** The sell unit's public status before this reservation. */
  readonly availability: Availability;
  /** The Market's default cap `D` (AU 10). */
  readonly defaultCap: number;
  /** `MarketConfig.maxLineQuantity` (AU 99): the cap never exceeds it. */
  readonly lineCeiling: number;
}

export const CustomerCapPolicy = {
  /**
   * The Offer's limit when it has one; else, when the status is `low`, `min(D, ceil(onlyLeft / 2))`
   * (rounded up so one remaining unit can still be taken, AC 1); else `D`. Never above the ceiling.
   */
  capOf(input: CapInput): number {
    const { purchaseLimit, availability, defaultCap, lineCeiling } = input;
    let cap: number;
    if (purchaseLimit !== null) {
      cap = purchaseLimit;
    } else if (availability.status === 'low' && availability.onlyLeft !== null) {
      cap = Math.min(defaultCap, Math.ceil(availability.onlyLeft / 2));
    } else {
      cap = defaultCap;
    }
    return Math.min(cap, lineCeiling);
  },
} as const;
