import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type {
  MailedDecision,
  SendDecisionMail,
} from '../../application/use-cases/send-decision-mail.use-case';
import {
  SellerCertificationApproved,
  SellerCertificationChangesRequested,
  SellerCertificationDeclined,
  SellerCertificationRevoked,
} from '../../domain/events';

/** The subscriber names: also the `handler` of `certification.inbox`. */
export const APPROVED_MAIL_SUBSCRIBER = 'certification.approved-mail';
export const CHANGES_REQUESTED_MAIL_SUBSCRIBER = 'certification.changes-requested-mail';
export const DECLINED_MAIL_SUBSCRIBER = 'certification.declined-mail';
export const REVOKED_MAIL_SUBSCRIBER = 'certification.revoked-mail';

/**
 * The subscriptions of certification's decision mail (design 8.4, 12) to its own events
 * `seller-certification-approved.v1`, `-changes-requested.v1`, `-declined.v1` and `-revoked.v1`. Each passes the
 * decoded event's ids, the delivery and the Market's system-actor context unchanged to the one
 * `system` use case. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function decisionMailSubscriptions(mail: SendDecisionMail): RegisteredSubscription[] {
  const handler =
    (name: string, decision: MailedDecision) =>
    async (
      event: {
        readonly payload: {
          readonly sellerCertificationId: string;
          readonly sellerId: string;
          readonly submissionId: string;
        };
      },
      delivery: EventDelivery,
      context: SubscriberContext,
    ): Promise<void> => {
      const result = await mail.execute(context, {
        delivery,
        certificateId: event.payload.sellerCertificationId,
        sellerId: event.payload.sellerId,
        submissionId: event.payload.submissionId,
        decision,
      });
      if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
    };
  return [
    subscription({
      name: APPROVED_MAIL_SUBSCRIBER,
      event: SellerCertificationApproved,
      handle: handler(APPROVED_MAIL_SUBSCRIBER, 'approved'),
    }),
    subscription({
      name: CHANGES_REQUESTED_MAIL_SUBSCRIBER,
      event: SellerCertificationChangesRequested,
      handle: handler(CHANGES_REQUESTED_MAIL_SUBSCRIBER, 'changes-requested'),
    }),
    subscription({
      name: DECLINED_MAIL_SUBSCRIBER,
      event: SellerCertificationDeclined,
      handle: handler(DECLINED_MAIL_SUBSCRIBER, 'declined'),
    }),
    subscription({
      name: REVOKED_MAIL_SUBSCRIBER,
      event: SellerCertificationRevoked,
      handle: handler(REVOKED_MAIL_SUBSCRIBER, 'revoked'),
    }),
  ];
}
