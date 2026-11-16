import { ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import { REVIEW_AREAS } from '../../../system-requests';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import {
  ADMIN_NOTICE_KINDS,
  ADMIN_SYSTEM_REQUEST_OVERDUE_KINDS,
  SYSTEM_REQUEST_AREAS,
} from '../../domain/in-app-notice';
import {
  SYSTEM_REQUEST_NOTICE_SUBSCRIBERS,
  systemRequestNoticeSubscriptions,
} from './system-request-notice.subscriptions';

// The reminder for an overdue system request: the request's id, SR number and age only; a
// refusal is thrown so the delivery is retried.

const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const REQUEST = '01990000-0000-7000-8000-000000000095';

function subscriptions(refuse = false) {
  const seen: unknown[] = [];
  const admin = {
    execute: (_c: unknown, input: unknown) => {
      seen.push(input);
      return Promise.resolve(refuse ? { ok: false as const, error: { code: 'x' } } : ok({}));
    },
  } as unknown as RecordAdminReviewNotice;
  const [subscription] = systemRequestNoticeSubscriptions(admin);
  return { seen, subscription: subscription! };
}

describe('system request notice subscriptions', () => {
  it('names the same areas as system-requests', () => {
    expect([...SYSTEM_REQUEST_AREAS]).toEqual([...REVIEW_AREAS]);
    for (const area of REVIEW_AREAS) {
      expect(ADMIN_NOTICE_KINDS).toContain(ADMIN_SYSTEM_REQUEST_OVERDUE_KINDS[area]);
    }
  });

  it('turns an overdue reminder into the notice of its area with the id, number and age only', async () => {
    const { seen, subscription } = subscriptions();
    expect(subscription.name).toBe(SYSTEM_REQUEST_NOTICE_SUBSCRIBERS.overdue);
    await subscription.handle(
      {
        payload: {
          requestId: REQUEST,
          number: 12,
          area: 'money',
          ageDays: 9,
          note: 'must never be forwarded',
        },
      } as never,
      delivery,
      context,
    );
    expect(seen).toEqual([
      {
        delivery,
        item: {
          kind: 'admin.system-request-overdue-money',
          requestId: REQUEST,
          number: 12,
          ageDays: 9,
        },
      },
    ]);
  });

  it('throws a refusal so that the delivery is retried', async () => {
    const { subscription } = subscriptions(true);
    await expect(
      subscription.handle(
        { payload: { requestId: REQUEST, number: 1, area: 'people', ageDays: 7 } } as never,
        delivery,
        context,
      ),
    ).rejects.toThrow(/refused/);
  });
});
