import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { SendExistingAccountMail } from '../../application/use-cases/send-existing-account-mail.use-case';
import type { SendLinkMail } from '../../application/use-cases/send-link-mail.use-case';
import { OneTimeLinkRequested, SignUpRepeated } from '../../domain/events';

/** The subscriber names: also the `handler` of `identity.inbox` (data design 3.8). */
export const LINK_MAIL_SUBSCRIBER = 'identity.link-mail';
export const EXISTING_ACCOUNT_MAIL_SUBSCRIBER = 'identity.existing-account-mail';

/**
 * Identity's subscriptions to its own events for mail (identity design 8, 9; decided by Ali,
 * 14.1-6; slice 3). Each is an entry adapter: the dispatcher hands it the decoded event, the
 * delivery and the Market's system-actor context, which go unchanged to one `system` use case.
 * A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with
 * an alert (P 6.4).
 */
export function identityMailSubscriptions(
  sendLinkMail: SendLinkMail,
  sendExistingAccountMail: SendExistingAccountMail,
): RegisteredSubscription[] {
  return [
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
  ];
}
