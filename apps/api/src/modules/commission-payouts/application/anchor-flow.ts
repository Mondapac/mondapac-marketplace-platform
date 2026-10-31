import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { ANCHOR_SOURCES, eligibleAtOf, holdDaysFor } from '../domain/payout-terms';
import type { SellerOrderDelivered } from '../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';

// The eligibility anchor (package 6b; G2 2.4, 4.5): when a seller order is delivered, ordering
// sends the delivery facts (the instant and who confirmed it) and this module freezes the instant
// the money becomes eligible: delivered_at + the carrier hold when the carrier confirmed the
// delivery, else + the seller-click hold. Written once; a repeat or a later fact changes nothing.

export type AnchorFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed' }
  /**
   * No usable payout terms (the Market has none, or a stored value is out of its bounds): nothing
   * is anchored; the caller tries again later.
   */
  | { readonly code: 'commission-payouts.terms-unavailable' };

export async function recordSellerOrderDelivered(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: SellerOrderDelivered,
): Promise<Result<'anchored' | 'already-anchored', AnchorFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  const sellerId = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  if (
    orderId === null ||
    !orderId.ok ||
    sellerOrderId === null ||
    !sellerOrderId.ok ||
    sellerId === null ||
    !sellerId.ok ||
    !(input.deliveredAt instanceof Temporal.Instant) ||
    !ANCHOR_SOURCES.includes(input.source)
  ) {
    return err({ code: 'validation.failed' });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<'anchored' | 'already-anchored', AnchorFailure>(
    context.market,
    async () => {
      const resolved = await deps.terms.resolve(context.market, sellerId.value);
      if (!resolved.ok) return resolved;
      const holdDays = holdDaysFor(input.source, resolved.value.terms);
      const inserted = await deps.anchors.insertIfAbsent(context.market, {
        sellerOrderId: sellerOrderId.value,
        orderId: orderId.value,
        sellerId: sellerId.value,
        deliveredAt: input.deliveredAt,
        source: input.source,
        holdDaysApplied: holdDays,
        eligibleAt: eligibleAtOf(input.deliveredAt, holdDays),
        recordedAt: now,
      });
      // The seller's payout schedule starts with its first anchor: no slot before it is due.
      await deps.cursors.ensure(context.market, sellerId.value, now);
      return ok(inserted ? ('anchored' as const) : ('already-anchored' as const));
    },
  );
}
