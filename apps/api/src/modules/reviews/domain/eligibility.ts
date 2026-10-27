import type { Id, Temporal } from '@mondapac/shared-kernel';
import { isWithinReviewWindow } from './rules';

// Who may review (owner decision N1): the account owns a seller order whose fulfilment is
// `delivered`. Ordering answers which seller orders those are (the eligibility is never copied
// into this module); this file only decides among them.

/** One delivered line of one delivered seller order of the account, with its product. */
export interface PurchaseCandidate {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly deliveredAt: Temporal.Instant;
}

export type Eligibility =
  | { readonly kind: 'eligible'; readonly purchase: PurchaseCandidate }
  /** The account had the product delivered, but every delivery is past the review window. */
  | { readonly kind: 'window-closed' }
  | { readonly kind: 'not-eligible' };

/**
 * The latest delivered purchase of `productId` still inside the window; else `window-closed`
 * when there was any delivery of it, else `not-eligible`. The latest one names the offer and the
 * seller of the "Bought from" label.
 */
export function evaluateEligibility(
  candidates: readonly PurchaseCandidate[],
  productId: Id<'Product'>,
  now: Temporal.Instant,
  windowDays: number,
): Eligibility {
  const ofProduct = candidates.filter((candidate) => candidate.productId === productId);
  if (ofProduct.length === 0) return { kind: 'not-eligible' };
  let best: PurchaseCandidate | null = null;
  for (const candidate of ofProduct) {
    if (!isWithinReviewWindow(candidate.deliveredAt, now, windowDays)) continue;
    if (
      best === null ||
      candidate.deliveredAt.epochMilliseconds > best.deliveredAt.epochMilliseconds
    ) {
      best = candidate;
    }
  }
  return best === null ? { kind: 'window-closed' } : { kind: 'eligible', purchase: best };
}
