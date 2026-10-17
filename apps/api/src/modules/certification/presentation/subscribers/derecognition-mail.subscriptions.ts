import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { SendDerecognitionMail } from '../../application/use-cases/send-derecognition-mail.use-case';
import { IssuerDeactivated } from '../../domain/events';

/** The subscriber name: also the `handler` of `certification.inbox`. */
export const DERECOGNITION_MAIL_SUBSCRIBER = 'certification.derecognition-mail';

/**
 * The subscription of the derecognition mail (design 8.4, 12) to the module's own
 * `issuer-deactivated.v1`. It passes the issuer id, the form, the delivery and the Market's
 * system-actor context unchanged to the one `system` use case, which mails only for form 2
 * (`derecognised`) and marks every delivery. A refusal throws, so the delivery is retried and, after
 * its last attempt, dead-lettered with an alert.
 */
export function derecognitionMailSubscriptions(
  mail: SendDerecognitionMail,
): RegisteredSubscription[] {
  return [
    subscription({
      name: DERECOGNITION_MAIL_SUBSCRIBER,
      event: IssuerDeactivated,
      handle: async (event, delivery: EventDelivery, context: SubscriberContext): Promise<void> => {
        const result = await mail.execute(context, {
          delivery,
          issuerId: event.payload.issuerId,
          form: event.payload.form,
        });
        if (!result.ok)
          throw new Error(`${DERECOGNITION_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
  ];
}
