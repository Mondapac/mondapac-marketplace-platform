import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { PayoutTermsChanged, SellerReinstatedHoldRemains } from '../../../commission-payouts';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import type { RecordSellerNotice } from '../../application/use-cases/record-seller-notice.use-case';
import {
  ADMIN_SELLER_REINSTATED_HOLD_REMAINS,
  SELLER_PAYOUT_TERMS_CHANGED,
} from '../../domain/in-app-notice';

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER = 'notifications.seller-payout-terms-notice';
export const ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER = 'notifications.admin-reinstated-hold-notice';

/**
 * Notifications' subscriptions for the payout run (package 6d). A change of a seller's payout
 * terms becomes one notice for that seller; a reinstated seller whose payouts stay on hold
 * becomes one admin notice (it replaces the log line `note-seller-reinstated` wrote before). Ids
 * only: no amounts, no reasons. A refusal throws, so the delivery is retried and, after its last
 * attempt, dead-lettered with an alert.
 */
export function payoutNoticeSubscriptions(
  sellerNotice: RecordSellerNotice,
  adminNotice: RecordAdminReviewNotice,
): RegisteredSubscription[] {
  return [
    subscription({
      name: SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER,
      event: PayoutTermsChanged,
      handle: async (event, delivery, context) => {
        const result = await sellerNotice.execute(context, {
          delivery,
          item: {
            kind: SELLER_PAYOUT_TERMS_CHANGED,
            owner: { by: 'seller', sellerId: event.payload.sellerId },
            params: {},
          },
        });
        if (!result.ok) {
          throw new Error(`${SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER,
      event: SellerReinstatedHoldRemains,
      handle: async (event, delivery, context) => {
        const result = await adminNotice.execute(context, {
          delivery,
          item: { kind: ADMIN_SELLER_REINSTATED_HOLD_REMAINS, sellerId: event.payload.sellerId },
        });
        if (!result.ok) {
          throw new Error(
            `${ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
  ];
}
