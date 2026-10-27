import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { DisputeChanged } from '../../../payments';
import type { SyncDispute } from '../../application/use-cases/sync-dispute.use-case';

/** The subscriber name: also the `handler` of `commission_payouts.inbox`. */
export const SYNC_DISPUTE_SUBSCRIBER = 'commission-payouts.sync-dispute';

/**
 * Commission-payouts' subscription to `payments.dispute-changed.v1` (package 8b; G2 4.10): the
 * event is a trigger only, so the decoded dispute id, the delivery and the Market's system-actor
 * context go unchanged to one `system` use case, which reads the dispute and acts on its state. A
 * refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with an
 * alert.
 */
export function disputeSubscriptions(sync: SyncDispute): RegisteredSubscription[] {
  return [
    subscription({
      name: SYNC_DISPUTE_SUBSCRIBER,
      event: DisputeChanged,
      handle: async (event, delivery, context) => {
        const result = await sync.execute(context, {
          delivery,
          disputeId: event.payload.disputeId,
        });
        if (!result.ok) throw new Error(`${SYNC_DISPUTE_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
  ];
}
