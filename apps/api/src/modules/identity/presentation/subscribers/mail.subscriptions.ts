import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { SendExistingAccountMail } from '../../application/use-cases/send-existing-account-mail.use-case';
import type { SendInvitationMail } from '../../application/use-cases/send-invitation-mail.use-case';
import type { SendLinkMail } from '../../application/use-cases/send-link-mail.use-case';
import type { SendPasswordChangedMail } from '../../application/use-cases/send-password-changed-mail.use-case';
import type { SendSecondFactorMail } from '../../application/use-cases/send-second-factor-mail.use-case';
import type {
  SendSellerAccessMail,
  SendSellerAccessMailInput,
} from '../../application/use-cases/send-seller-access-mail.use-case';
import type { SendWelcomeMail } from '../../application/use-cases/send-welcome-mail.use-case';
import {
  AccountPasswordChanged,
  InvitationIssued,
  OneTimeLinkRequested,
  SecondFactorChanged,
  SellerAccessApproved,
  SellerAccessRejected,
  SellerAccessReinstated,
  SellerAccessSuspended,
  SellerRegistered,
  SignUpRepeated,
} from '../../domain/events';

/** The subscriber names: also the `handler` of `identity.inbox` (data design 3.8). */
export const LINK_MAIL_SUBSCRIBER = 'identity.link-mail';
export const EXISTING_ACCOUNT_MAIL_SUBSCRIBER = 'identity.existing-account-mail';
export const WELCOME_MAIL_SUBSCRIBER = 'identity.welcome-mail';
export const PASSWORD_CHANGED_MAIL_SUBSCRIBER = 'identity.password-changed-mail';
/** Slice 7b: the invitation mail and the second-factor notice. */
export const INVITATION_MAIL_SUBSCRIBER = 'identity.invitation-mail';
export const SECOND_FACTOR_MAIL_SUBSCRIBER = 'identity.second-factor-mail';
/** Slice 9: the result mails of the access decisions (`ux.md` E4 to E7), one per event. */
export const SELLER_APPROVED_MAIL_SUBSCRIBER = 'identity.seller-approved-mail';
export const SELLER_REJECTED_MAIL_SUBSCRIBER = 'identity.seller-rejected-mail';
export const SELLER_SUSPENDED_MAIL_SUBSCRIBER = 'identity.seller-suspended-mail';
export const SELLER_REINSTATED_MAIL_SUBSCRIBER = 'identity.seller-reinstated-mail';

/**
 * Identity's subscriptions to its own events for mail (identity design 8, 9; decided by Ali,
 * 14.1-6; slices 3 to 5). Each is an entry adapter: the dispatcher hands it the decoded event, the
 * delivery and the Market's system-actor context, which go unchanged to one `system` use case.
 * A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with
 * an alert (P 6.4).
 */
export function identityMailSubscriptions(
  sendLinkMail: SendLinkMail,
  sendExistingAccountMail: SendExistingAccountMail,
  sendWelcomeMail: SendWelcomeMail,
  sendPasswordChangedMail: SendPasswordChangedMail,
  sendInvitationMail: SendInvitationMail,
  sendSecondFactorMail: SendSecondFactorMail,
  sendSellerAccessMail: SendSellerAccessMail,
): RegisteredSubscription[] {
  /** One decision event's delivery to the decision mail handler. */
  const decisionMail = async (
    name: string,
    decision: SendSellerAccessMailInput['decision'],
    payload: Pick<SendSellerAccessMailInput, 'sellerId' | 'decisionId'>,
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await sendSellerAccessMail.execute(context, {
      delivery,
      sellerId: payload.sellerId,
      decisionId: payload.decisionId,
      decision,
    });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: SELLER_APPROVED_MAIL_SUBSCRIBER,
      event: SellerAccessApproved,
      handle: (event, delivery, context) =>
        decisionMail(SELLER_APPROVED_MAIL_SUBSCRIBER, 'approved', event.payload, delivery, context),
    }),
    subscription({
      name: SELLER_REJECTED_MAIL_SUBSCRIBER,
      event: SellerAccessRejected,
      handle: (event, delivery, context) =>
        decisionMail(SELLER_REJECTED_MAIL_SUBSCRIBER, 'rejected', event.payload, delivery, context),
    }),
    subscription({
      name: SELLER_SUSPENDED_MAIL_SUBSCRIBER,
      event: SellerAccessSuspended,
      handle: (event, delivery, context) =>
        decisionMail(
          SELLER_SUSPENDED_MAIL_SUBSCRIBER,
          'suspended',
          event.payload,
          delivery,
          context,
        ),
    }),
    subscription({
      name: SELLER_REINSTATED_MAIL_SUBSCRIBER,
      event: SellerAccessReinstated,
      handle: (event, delivery, context) =>
        decisionMail(
          SELLER_REINSTATED_MAIL_SUBSCRIBER,
          'reinstated',
          event.payload,
          delivery,
          context,
        ),
    }),
    subscription({
      name: LINK_MAIL_SUBSCRIBER,
      event: OneTimeLinkRequested,
      async handle(event, delivery, context) {
        const result = await sendLinkMail.execute(context, {
          delivery,
          linkId: event.payload.linkId,
          accountId: event.payload.accountId,
          purpose: event.payload.purpose,
          aggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) throw new Error(`${LINK_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    subscription({
      name: EXISTING_ACCOUNT_MAIL_SUBSCRIBER,
      event: SignUpRepeated,
      async handle(event, delivery, context) {
        const result = await sendExistingAccountMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          cause: event.payload.cause,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(`${EXISTING_ACCOUNT_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: WELCOME_MAIL_SUBSCRIBER,
      event: SellerRegistered,
      async handle(event, delivery, context) {
        const result = await sendWelcomeMail.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          ownerAccountId: event.payload.ownerAccountId,
          origin: event.payload.origin,
          accessState: event.payload.accessState,
        });
        if (!result.ok) throw new Error(`${WELCOME_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    subscription({
      name: INVITATION_MAIL_SUBSCRIBER,
      event: InvitationIssued,
      async handle(event, delivery, context) {
        const result = await sendInvitationMail.execute(context, {
          delivery,
          invitationId: event.payload.invitationId,
          aggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) {
          throw new Error(`${INVITATION_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: SECOND_FACTOR_MAIL_SUBSCRIBER,
      event: SecondFactorChanged,
      async handle(event, delivery, context) {
        const result = await sendSecondFactorMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          change: event.payload.change,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(`${SECOND_FACTOR_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: PASSWORD_CHANGED_MAIL_SUBSCRIBER,
      event: AccountPasswordChanged,
      async handle(event, delivery, context) {
        const result = await sendPasswordChangedMail.execute(context, {
          delivery,
          accountId: event.payload.accountId,
          cause: event.payload.cause,
          occurredAt: event.occurredAt,
        });
        if (!result.ok) {
          throw new Error(`${PASSWORD_CHANGED_MAIL_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
