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
  /** The seller's effective low-stock threshold (design 5.2). */
  readonly lowStockThreshold: number;
}

export const CustomerCapPolicy = {
  /**
   * The Offer's limit when it has one; else, when the status is `low`, `min(D, ceil(onlyLeft / 2))`
   * (rounded up so one remaining unit can still be taken, AC 1); else `D`. Never above the ceiling.
   *
   * Cap oracle fix (M1, decided 2026-10-14, design 5.1): while the status is `in-stock` the public
   * fact is only "more than the threshold", so a request above `threshold + 1` could be told
   * apart by `not-enough` from a success and give the exact stock away. The cap is therefore also
   * limited to `threshold + 1`, a quantity an in-stock unit always has.
   */
  capOf(input: CapInput): number {
    const { purchaseLimit, availability, defaultCap, lineCeiling, lowStockThreshold } = input;
    let cap: number;
    if (purchaseLimit !== null) {
      cap = purchaseLimit;
    } else if (availability.status === 'low' && availability.onlyLeft !== null) {
      cap = Math.min(defaultCap, Math.ceil(availability.onlyLeft / 2));
    } else {
      cap = defaultCap;
    }
    if (availability.status === 'in-stock') cap = Math.min(cap, lowStockThreshold + 1);
    return Math.min(cap, lineCeiling);
  },
} as const;
