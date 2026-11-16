import type { Temporal } from '@mondapac/shared-kernel';
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
import type { CustomerEventKindInput } from '../../domain/customer-timeline';
import type { RecordCustomerTimeline } from '../../application/use-cases/record-customer-timeline.use-case';

/** The subscriber names: also the `handler` of the inbox. */
export const TIMELINE_SUBSCRIBERS = {
  registered: 'customers.timeline-registered',
  verified: 'customers.timeline-email-verified',
  renamed: 'customers.timeline-name-changed',
  disabled: 'customers.timeline-disabled',
  enabled: 'customers.timeline-enabled',
  orderPaid: 'customers.timeline-order-paid',
  refund: 'customers.timeline-refund-succeeded',
} as const;

/**
 * The customer timeline's subscriptions (phase 2, PR 2a). Each hands the decoded event's ids, its
 * id and instant, the delivery and the Market's system-actor context to `RecordCustomerTimeline`,
 * which writes one entry per event (a repeated delivery changes nothing). A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert. Identity's events
 * of other populations are not a customer's and are skipped.
 */
export function customerTimelineSubscriptions(
  record: RecordCustomerTimeline,
): RegisteredSubscription[] {
  const run = async (
    name: string,
    input: CustomerEventKindInput,
    event: { readonly eventId: string; readonly occurredAt: Temporal.Instant },
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await record.execute(context, {
      ...input,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      delivery,
    });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  const ofPopulation = (
    name: string,
    kind: 'email-verified' | 'name-changed' | 'account-disabled' | 'account-enabled',
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
        // A seller's or an admin's account is not a customer: nothing to record.
        if (consumed.payload.population !== 'customer') return;
        await run(
          name,
          { kind, accountId: consumed.payload.accountId },
          consumed,
          delivery,
          context,
        );
      },
    });
  return [
    subscription({
      name: TIMELINE_SUBSCRIBERS.registered,
      event: CustomerAccountRegistered,
      handle: (consumed, delivery, context) =>
        run(
          TIMELINE_SUBSCRIBERS.registered,
          { kind: 'signed-up', accountId: consumed.payload.accountId },
          consumed,
          delivery,
          context,
        ),
    }),
    ofPopulation(TIMELINE_SUBSCRIBERS.verified, 'email-verified', AccountEmailVerified),
    ofPopulation(TIMELINE_SUBSCRIBERS.renamed, 'name-changed', AccountDisplayNameChanged),
    ofPopulation(TIMELINE_SUBSCRIBERS.disabled, 'account-disabled', AccountDisabled),
    ofPopulation(TIMELINE_SUBSCRIBERS.enabled, 'account-enabled', AccountEnabled),
    subscription({
      name: TIMELINE_SUBSCRIBERS.orderPaid,
      event: OrderPaid,
      handle: (consumed, delivery, context) =>
        run(
          TIMELINE_SUBSCRIBERS.orderPaid,
          { kind: 'order-paid', orderId: consumed.payload.orderId },
          consumed,
          delivery,
          context,
        ),
    }),
    subscription({
      name: TIMELINE_SUBSCRIBERS.refund,
      event: RefundSucceeded,
      handle: (consumed, delivery, context) =>
        run(
          TIMELINE_SUBSCRIBERS.refund,
          {
            kind: 'refund-succeeded',
            orderId: consumed.payload.orderId,
            refundId: consumed.payload.refundId,
          },
          consumed,
          delivery,
          context,
        ),
    }),
  ];
}
