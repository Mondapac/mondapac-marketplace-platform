import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { TransferChanged } from '../../../payments';
import type { ApplyTransferChange } from '../../application/use-cases/apply-transfer-change.use-case';

/** The subscriber name: also the `handler` of `commission_payouts.inbox`. */
export const APPLY_TRANSFER_CHANGE_SUBSCRIBER = 'commission-payouts.apply-transfer-change';

/**
 * Commission-payouts' subscription to `payments.transfer-changed.v1` (package 6d; G2 3.6): the
 * event is a trigger only, so the decoded transfer id and the delivery go with the Market's
 * system-actor context to one `system` use case, which finds the payout, reads the transfer's
 * state by key and follows it. A refusal throws, so the delivery is retried and, after its last
 * attempt, dead-lettered with an alert; the reconcile job closes whatever is left.
 */
export function transferSubscriptions(apply: ApplyTransferChange): RegisteredSubscription[] {
  return [
    subscription({
      name: APPLY_TRANSFER_CHANGE_SUBSCRIBER,
      event: TransferChanged,
      handle: async (event, delivery, context) => {
        const result = await apply.execute(context, {
          delivery,
          transferExecutionId: event.payload.transferExecutionId,
          sellerId: event.payload.sellerId,
        });
        if (!result.ok) {
          throw new Error(`${APPLY_TRANSFER_CHANGE_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
