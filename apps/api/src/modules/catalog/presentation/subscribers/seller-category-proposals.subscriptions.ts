import type { Id } from '@mondapac/shared-kernel';
import { SellerCategoryProposalsRevoked } from '../../../sellers';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CancelPendingProposals } from '../../application/use-cases/cancel-pending-proposals.use-case';

/** The subscriber name: also the `handler` of `catalog.inbox`. */
export const CANCEL_PENDING_PROPOSALS_ON_REVOKED = 'catalog.cancel-pending-proposals-on-revoked';

/**
 * Catalog's subscription to `sellers.category-proposals-revoked.v1` (categories C9a; CAT-51, AC
 * 35). An entry adapter only: the delivery, the Market's system-actor context and the seller of the
 * payload go to the one `system` use case. A refusal throws, so the delivery is retried and, after
 * its last attempt, dead-lettered with an alert.
 */
export function sellerCategoryProposalSubscriptions(
  cancel: CancelPendingProposals,
): RegisteredSubscription[] {
  return [
    subscription({
      name: CANCEL_PENDING_PROPOSALS_ON_REVOKED,
      event: SellerCategoryProposalsRevoked,
      handle: async (event, delivery, context) => {
        const result = await cancel.execute(context, {
          delivery,
          sellerId: event.payload.sellerId as Id<'Seller'>,
        });
        if (!result.ok) {
          throw new Error(`${CANCEL_PENDING_PROPOSALS_ON_REVOKED} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
