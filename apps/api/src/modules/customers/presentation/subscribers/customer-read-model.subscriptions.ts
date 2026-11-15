import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  AccountDisabled,
  AccountDisplayNameChanged,
  AccountEmailVerified,
  AccountEnabled,
  CustomerAccountRegistered,
} from '../../../identity';
import { OrderPaid, RefundSucceeded } from '../../../ordering';
import type { SyncCustomerReadModel } from '../../application/use-cases/sync-customer-read-model.use-case';

/** The subscriber names: also the `handler` of the inbox. */
export const CUSTOMER_REGISTERED_SUBSCRIBER = 'customers.read-model-registered';
export const CUSTOMER_NAME_SUBSCRIBER = 'customers.read-model-name-changed';
export const CUSTOMER_VERIFIED_SUBSCRIBER = 'customers.read-model-email-verified';
export const CUSTOMER_DISABLED_SUBSCRIBER = 'customers.read-model-disabled';
export const CUSTOMER_ENABLED_SUBSCRIBER = 'customers.read-model-enabled';
export const CUSTOMER_ORDER_PAID_SUBSCRIBER = 'customers.read-model-order-paid';
export const CUSTOMER_REFUND_SUBSCRIBER = 'customers.read-model-refund-succeeded';

/**
 * The customers read models' subscriptions (package B1). Each hands the decoded event's ids, the
 * delivery and the Market's system-actor context unchanged to `SyncCustomerReadModel`, which
 * re-reads the owners and replaces the rows, so a repeated or late event is harmless. A refusal
 * throws, so the delivery is retried and, after its last attempt, dead-lettered with an alert.
 * Identity's events of other populations are read as a miss and leave the tables as they are.
 */
export function customerReadModelSubscriptions(
  sync: SyncCustomerReadModel,
): RegisteredSubscription[] {
  const run = async (
    name: string,
    input:
      { readonly accountId: string } | { readonly orderId: string; readonly refundId?: string },
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await sync.execute(context, { ...input, delivery });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  const byAccount = (name: string, event: typeof CustomerAccountRegistered) =>
    subscription({
      name,
      event,
      handle: (consumed, delivery, context) =>
        run(name, { accountId: consumed.payload.accountId }, delivery, context),
    });
  const byAccountOfPopulation = (
    name: string,
    event:
      | typeof AccountDisabled
      | typeof AccountEnabled
      | typeof AccountEmailVerified
      | typeof AccountDisplayNameChanged,
  ) =>
    subscription({
      name,
      event,
      handle: async (consumed, delivery, context) => {
        // A seller's or an admin's account is not a customer: nothing to copy.
        if (consumed.payload.population !== 'customer') return;
        await run(name, { accountId: consumed.payload.accountId }, delivery, context);
      },
    });
  return [
    byAccount(CUSTOMER_REGISTERED_SUBSCRIBER, CustomerAccountRegistered),
    byAccountOfPopulation(CUSTOMER_NAME_SUBSCRIBER, AccountDisplayNameChanged),
    byAccountOfPopulation(CUSTOMER_VERIFIED_SUBSCRIBER, AccountEmailVerified),
    byAccountOfPopulation(CUSTOMER_DISABLED_SUBSCRIBER, AccountDisabled),
    byAccountOfPopulation(CUSTOMER_ENABLED_SUBSCRIBER, AccountEnabled),
    subscription({
      name: CUSTOMER_ORDER_PAID_SUBSCRIBER,
      event: OrderPaid,
      handle: (consumed, delivery, context) =>
        run(
          CUSTOMER_ORDER_PAID_SUBSCRIBER,
          { orderId: consumed.payload.orderId },
          delivery,
          context,
        ),
    }),
    subscription({
      name: CUSTOMER_REFUND_SUBSCRIBER,
      event: RefundSucceeded,
      handle: (consumed, delivery, context) =>
        run(
          CUSTOMER_REFUND_SUBSCRIBER,
          { orderId: consumed.payload.orderId, refundId: consumed.payload.refundId },
          delivery,
          context,
        ),
    }),
  ];
}
