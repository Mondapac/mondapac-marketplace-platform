import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { SendExpiryMail } from '../../application/use-cases/send-expiry-mail.use-case';
import {
  SellerCertificationExpired,
  SellerCertificationExpiryWarningDue,
} from '../../domain/events';

/** The subscriber names: also the `handler` of `certification.inbox`. */
export const EXPIRY_WARNING_MAIL_SUBSCRIBER = 'certification.expiry-warning-mail';
export const EXPIRED_MAIL_SUBSCRIBER = 'certification.expired-mail';

/**
 * The subscriptions of the expiry mails (design 8.4, 12) to the module's own
 * `seller-certification-expiry-warning-due.v1` and `-expired.v1`. Each passes the decoded ids (and
 * the threshold), the delivery and the Market's system-actor context unchanged to the one
 * `system` use case. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function expiryMailSubscriptions(mail: SendExpiryMail): RegisteredSubscription[] {
  const run = async (
    name: string,
    input: Omit<Parameters<SendExpiryMail['execute']>[1], 'delivery'>,
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await mail.execute(context, { ...input, delivery });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: EXPIRY_WARNING_MAIL_SUBSCRIBER,
      event: SellerCertificationExpiryWarningDue,
      handle: (event, delivery, context) =>
        run(
          EXPIRY_WARNING_MAIL_SUBSCRIBER,
          {
            kind: 'warning',
            certificateId: event.payload.sellerCertificationId,
            sellerId: event.payload.sellerId,
            submissionId: event.payload.submissionId,
            thresholdDays: event.payload.thresholdDays,
          },
          delivery,
          context,
        ),
    }),
    subscription({
      name: EXPIRED_MAIL_SUBSCRIBER,
      event: SellerCertificationExpired,
      handle: (event, delivery, context) =>
        run(
          EXPIRED_MAIL_SUBSCRIBER,
          {
            kind: 'expired',
            certificateId: event.payload.sellerCertificationId,
            sellerId: event.payload.sellerId,
            submissionId: event.payload.submissionId,
            thresholdDays: null,
          },
          delivery,
          context,
        ),
    }),
  ];
}
