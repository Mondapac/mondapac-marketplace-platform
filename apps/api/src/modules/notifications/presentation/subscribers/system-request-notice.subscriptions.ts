import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { SystemRequestOverdue } from '../../../system-requests';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import { ADMIN_SYSTEM_REQUEST_OVERDUE_KINDS } from '../../domain/in-app-notice';

/** The subscriber name: also the `handler` of `notifications.inbox`. */
export const SYSTEM_REQUEST_NOTICE_SUBSCRIBERS = {
  overdue: 'notifications.admin-system-request-overdue-notice',
} as const;

/**
 * Notifications' subscription for system requests: a reminder that an open request is overdue
 * becomes one admin notice of the request's area, shown to the admins who hold that area's review
 * key. The notice holds the request id, SR number and age in days only (never the note or the
 * values). A refusal throws, so the delivery is retried and, after its last attempt,
 * dead-lettered with an alert.
 */
export function systemRequestNoticeSubscriptions(
  adminNotice: RecordAdminReviewNotice,
): RegisteredSubscription[] {
  const name = SYSTEM_REQUEST_NOTICE_SUBSCRIBERS.overdue;
  return [
    subscription({
      name,
      event: SystemRequestOverdue,
      handle: async (event, delivery: EventDelivery, context) => {
        const { requestId, number, area, ageDays } = event.payload;
        const result = await adminNotice.execute(context, {
          delivery,
          item: {
            kind: ADMIN_SYSTEM_REQUEST_OVERDUE_KINDS[area],
            requestId,
            number,
            ageDays,
          },
        });
        if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
      },
    }),
  ];
}
