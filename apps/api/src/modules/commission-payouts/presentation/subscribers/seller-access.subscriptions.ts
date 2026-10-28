import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { SellerAccessReinstated, SellerAccessSuspended } from '../../../identity';
import type { NoteSellerReinstated } from '../../application/use-cases/note-seller-reinstated.use-case';
import type { PlaceSellerSuspendedHold } from '../../application/use-cases/place-seller-suspended-hold.use-case';

/** The subscriber names: also the `handler` of `commission_payouts.inbox`. */
export const PLACE_SELLER_SUSPENDED_HOLD_SUBSCRIBER = 'commission-payouts.place-suspended-hold';
export const NOTE_SELLER_REINSTATED_SUBSCRIBER = 'commission-payouts.note-seller-reinstated';

/**
 * Commission-payouts' subscriptions to identity's seller access (package 6b; G2 3.5, 6.4): a
 * suspended seller gets a system `seller-suspended` hold on all its payouts (idempotent by the
 * suspension's decision id); a reinstated seller releases nothing, an admin is told. Each passes
 * the decoded ids, the delivery and the Market's system-actor context unchanged to one `system`
 * use case. A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function sellerAccessSubscriptions(
  suspended: PlaceSellerSuspendedHold,
  reinstated: NoteSellerReinstated,
): RegisteredSubscription[] {
  return [
    subscription({
      name: PLACE_SELLER_SUSPENDED_HOLD_SUBSCRIBER,
      event: SellerAccessSuspended,
      handle: async (event, delivery, context) => {
        const result = await suspended.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          decisionId: event.payload.decisionId,
        });
        if (!result.ok) {
          throw new Error(
            `${PLACE_SELLER_SUSPENDED_HOLD_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
    subscription({
      name: NOTE_SELLER_REINSTATED_SUBSCRIBER,
      event: SellerAccessReinstated,
      handle: async (event, delivery, context) => {
        const result = await reinstated.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          decisionId: event.payload.decisionId,
        });
        if (!result.ok) {
          throw new Error(`${NOTE_SELLER_REINSTATED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
