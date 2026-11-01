import type { SellerOverlapSource } from '../application/ports/seller-overlap';

/**
 * Bound until ordering and payments can answer cheaply: ordering's facade carries no delivery
 * address and payments' facade no payment-method fingerprint (see docs/modules/reviews/notes.md).
 * It knows nothing, so it raises no signal; swap `SELLER_OVERLAP_SOURCE` when those reads exist.
 */
export class UnavailableSellerOverlap implements SellerOverlapSource {
  factsFor(): Promise<null> {
    return Promise.resolve(null);
  }
}
