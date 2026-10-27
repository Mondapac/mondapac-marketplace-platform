import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { DeliveredSellerOrder } from '../../ordering';
import type { PurchaseCandidate } from '../domain/eligibility';
import { windowEndsAt } from '../domain/rules';
import type { ReviewsSettings } from './ports/reviews-policy';
import type { ReviewsDependencies } from './reviews-dependencies';

// Eligibility is asked of `ordering` through its facade at write time (owner decision N1); no
// eligibility table is kept here. The customer's own CallContext goes through unchanged, so
// ordering applies its own-resources rule: another customer's orders cannot be asked for.

/**
 * How far back past the review window deliveries are asked for. It only decides whether a refusal
 * is `window-closed` ("too late") or `not-eligible` ("never bought"); the window itself is
 * enforced by `evaluateEligibility` from Market config.
 */
const LOOKBACK_FACTOR = 4;
const CATALOG_BATCH = 200;

export type PurchasesFailure = { readonly code: 'reviews.unavailable' };

export interface DeliveredPurchases {
  readonly orders: readonly DeliveredSellerOrder[];
  /** One candidate per (delivered seller order, offer) whose product catalog could name. */
  readonly candidates: readonly PurchaseCandidate[];
}

export function lookbackSince(now: Temporal.Instant, settings: ReviewsSettings): Temporal.Instant {
  return now.subtract({ hours: settings.reviewWindowDays * 24 * LOOKBACK_FACTOR });
}

export function windowClosesAt(
  deliveredAt: Temporal.Instant,
  settings: ReviewsSettings,
): Temporal.Instant {
  return windowEndsAt(deliveredAt, settings.reviewWindowDays);
}

/** The customer's delivered seller orders, each offer mapped to its product. */
export async function deliveredPurchases(
  deps: ReviewsDependencies,
  context: CallContext,
  query: { readonly since: Temporal.Instant; readonly sellerOrderId?: Id<'SellerOrder'> },
  withProducts: boolean,
): Promise<Result<DeliveredPurchases, PurchasesFailure>> {
  const delivered = await deps.ordering.myDeliveredSellerOrders(context, {
    deliveredSince: query.since,
    ...(query.sellerOrderId === undefined ? {} : { sellerOrderId: query.sellerOrderId }),
  });
  if (!delivered.ok) return err({ code: 'reviews.unavailable' });
  if (!withProducts) return ok({ orders: delivered.value, candidates: [] });

  const offerIds = [...new Set(delivered.value.flatMap((order) => order.offerIds))];
  const productOf = new Map<Id<'Offer'>, Id<'Product'>>();
  for (let from = 0; from < offerIds.length; from += CATALOG_BATCH) {
    const answer = await deps.catalog.offerSellUnits(
      context,
      offerIds.slice(from, from + CATALOG_BATCH),
    );
    if (!answer.ok) return err({ code: 'reviews.unavailable' });
    for (const [offerId, units] of answer.value) productOf.set(offerId, units.productId);
  }
  const candidates: PurchaseCandidate[] = [];
  for (const order of delivered.value) {
    for (const offerId of order.offerIds) {
      const productId = productOf.get(offerId);
      if (productId === undefined) continue;
      candidates.push({
        sellerOrderId: order.sellerOrderId,
        sellerId: order.sellerId,
        offerId,
        productId,
        deliveredAt: order.deliveredAt,
      });
    }
  }
  return ok({ orders: delivered.value, candidates });
}
