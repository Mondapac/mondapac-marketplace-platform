import {
  SellerAccessApproved,
  SellerAccessRejected,
} from '../../../identity/contracts/seller-access.contract';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CloseDecision } from '../../application/use-cases/close-decision.use-case';

/** The subscriber names (also the `handler` of `sellers.inbox`), one per decision event. */
export const CLOSE_APPROVAL_SUBSCRIBER = 'sellers.close-decision-approved';
export const CLOSE_REJECTION_SUBSCRIBER = 'sellers.close-decision-rejected';

/**
 * Sellers' subscriptions to `identity`'s decision events (sellers design 7.3, 7.5; slice
 * 7a-decide): the use case `sellers.close-decision` for the approval and the rejection, under one
 * subscription name per event (a name is registered once). A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function decisionSubscriptions(closeDecision: CloseDecision): RegisteredSubscription[] {
  return [
    subscription({
      name: CLOSE_APPROVAL_SUBSCRIBER,
      event: SellerAccessApproved,
      async handle(event, delivery, context) {
        const result = await closeDecision.execute(context, {
          delivery,
          outcome: 'approved',
          sellerId: event.payload.sellerId,
          decisionId: event.payload.decisionId,
          basisId: event.payload.basisId,
        });
        if (!result.ok)
          throw new Error(`${CLOSE_APPROVAL_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    subscription({
      name: CLOSE_REJECTION_SUBSCRIBER,
      event: SellerAccessRejected,
      async handle(event, delivery, context) {
        const result = await closeDecision.execute(context, {
          delivery,
          outcome: 'rejected',
          sellerId: event.payload.sellerId,
          decisionId: event.payload.decisionId,
          basisId: event.payload.basisId,
        });
        if (!result.ok)
          throw new Error(`${CLOSE_REJECTION_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
  ];
}
