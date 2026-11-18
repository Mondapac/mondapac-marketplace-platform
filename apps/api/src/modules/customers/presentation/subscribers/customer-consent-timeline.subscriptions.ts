import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { MarketingConsentChanged } from '../../../legal';
import type { RecordCustomerTimeline } from '../../application/use-cases/record-customer-timeline.use-case';

/** The subscriber name: also the `handler` of the inbox. */
export const CONSENT_TIMELINE_SUBSCRIBER = 'customers.timeline-consent-changed';

/**
 * The customer timeline's subscription on legal's consent event (phase 2b, part 4). The event
 * names the account and the channel, never the value; `RecordCustomerTimeline` writes one
 * `consent-changed` entry with the channel as its detail, once per delivery (`runOnce` and the
 * inbox) and once per event. A refusal throws, so the delivery is retried and, after its last
 * attempt, dead-lettered with an alert. Registered by `CustomersSectionsModule`, which imports
 * `legal`.
 */
export function customerConsentTimelineSubscriptions(
  record: RecordCustomerTimeline,
): RegisteredSubscription[] {
  return [
    subscription({
      name: CONSENT_TIMELINE_SUBSCRIBER,
      event: MarketingConsentChanged,
      handle: async (consumed, delivery, context) => {
        const result = await record.execute(context, {
          kind: 'consent-changed',
          accountId: consumed.payload.accountId,
          channel: consumed.payload.channel,
          eventId: consumed.eventId,
          occurredAt: consumed.occurredAt,
          delivery,
        });
        if (!result.ok) {
          throw new Error(`${CONSENT_TIMELINE_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
