import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { SendIssuerRequestMail } from '../../application/use-cases/send-issuer-request-mail.use-case';
import { IssuerRequestAnswered } from '../../domain/events';

/** The subscriber name: also the `handler` of `certification.inbox`. */
export const ISSUER_REQUEST_MAIL_SUBSCRIBER = 'certification.issuer-request-mail';

/**
 * The subscription of the issuer request answer mail (design 8.4, 12) to the module's own
 * `issuer-request-answered.v1`. It passes the decoded ids and outcome, the delivery and the
 * Market's system-actor context unchanged to the one `system` use case. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function issuerRequestMailSubscriptions(
  mail: SendIssuerRequestMail,
): RegisteredSubscription[] {
  return [
    subscription({
      name: ISSUER_REQUEST_MAIL_SUBSCRIBER,
      event: IssuerRequestAnswered,
      handle: async (event, delivery: EventDelivery, context: SubscriberContext): Promise<void> => {
        const result = await mail.execute(context, {
          delivery,
          issuerRequestId: event.payload.issuerRequestId,
          sellerId: event.payload.sellerId,
          outcome: event.payload.outcome,
        });
        if (!result.ok)
          throw new Error(`${ISSUER_REQUEST_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
  ];
}
