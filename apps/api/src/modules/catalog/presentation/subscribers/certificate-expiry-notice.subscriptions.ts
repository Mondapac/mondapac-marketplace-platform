import { ProductCertificationExpiryWarningDue } from '../../../certification';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { WarnOfferOwnersOfExpiry } from '../../application/use-cases/warn-offer-owners-of-expiry.use-case';

/** The subscriber name: also the `handler` of `catalog.inbox`. */
export const WARN_OFFER_OWNERS_OF_EXPIRY = 'catalog.warn-offer-owners-of-expiry';

/**
 * Catalog's subscription to certification's `product-certification-expiry-warning-due.v1`
 * (certification design 8.3, request C-6; slice 15). An entry adapter only: the delivery and the
 * Market's system-actor context (the Market from the envelope) go unchanged to the one `system`
 * use case, with the certificate id and the threshold from the payload. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function certificateExpiryNoticeSubscriptions(
  warn: WarnOfferOwnersOfExpiry,
): RegisteredSubscription[] {
  return [
    subscription({
      name: WARN_OFFER_OWNERS_OF_EXPIRY,
      event: ProductCertificationExpiryWarningDue,
      handle: async (event, delivery, context) => {
        const result = await warn.execute(context, {
          delivery,
          productCertificationId: event.payload.productCertificationId,
          thresholdDays: event.payload.thresholdDays,
        });
        if (!result.ok) {
          throw new Error(`${WARN_OFFER_OWNERS_OF_EXPIRY} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
