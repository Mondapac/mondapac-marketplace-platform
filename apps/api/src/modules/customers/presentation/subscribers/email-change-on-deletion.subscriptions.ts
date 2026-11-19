import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CancelEmailChangeOnDeletion } from '../../application/use-cases/cancel-email-change-on-deletion.use-case';
import {
  AccountDeletionRequestedByAdminEvent,
  AccountDeletionRequestedEvent,
} from '../../domain/events';

/** The subscriber names: also the `handler` of the inbox. */
export const EMAIL_CHANGE_ON_DELETION_SUBSCRIBER = 'customers.email-change-on-deletion';
export const EMAIL_CHANGE_ON_ADMIN_DELETION_SUBSCRIBER = 'customers.email-change-on-admin-deletion';

/**
 * Customers' subscriptions to its own deletion-requested events (customers admin email change;
 * Hassan R6, L2): each hands the request id (the aggregate id), the delivery and the Market's
 * system-actor context unchanged to `CancelEmailChangeOnDeletion`. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function emailChangeOnDeletionSubscriptions(
  cancel: CancelEmailChangeOnDeletion,
): RegisteredSubscription[] {
  const of = (
    name: string,
    event: typeof AccountDeletionRequestedEvent | typeof AccountDeletionRequestedByAdminEvent,
  ) =>
    subscription({
      name,
      event,
      async handle(consumed, delivery, context) {
        const result = await cancel.execute(context, {
          requestId: consumed.aggregateId,
          delivery,
        });
        if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
      },
    });
  return [
    of(EMAIL_CHANGE_ON_DELETION_SUBSCRIBER, AccountDeletionRequestedEvent),
    of(EMAIL_CHANGE_ON_ADMIN_DELETION_SUBSCRIBER, AccountDeletionRequestedByAdminEvent),
  ];
}
