import { ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import type { RecordSellerNotice } from '../../application/use-cases/record-seller-notice.use-case';
import {
  REVIEW_NOTICE_SUBSCRIBERS,
  reviewNoticeSubscriptions,
} from './review-notice.subscriptions';

// The review notices (buyer reviews, package 4b). Ids and the star count only; a refusal is
// thrown so the delivery is retried.

const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const IDS = {
  reviewId: '01990000-0000-7000-8000-000000000071',
  productId: '01990000-0000-7000-8000-000000000072',
  sellerId: '01990000-0000-7000-8000-000000000051',
  reportId: '01990000-0000-7000-8000-000000000073',
};

function subscriptions(refuse = false) {
  const seen: { seller: unknown[]; admin: unknown[] } = { seller: [], admin: [] };
  const answer = () =>
    Promise.resolve(refuse ? { ok: false as const, error: { code: 'x' } } : ok({ code: 'ok' }));
  const seller = {
    execute: (_c: unknown, input: unknown) => (seen.seller.push(input), answer()),
  } as unknown as RecordSellerNotice;
  const admin = {
    execute: (_c: unknown, input: unknown) => (seen.admin.push(input), answer()),
  } as unknown as RecordAdminReviewNotice;
  const all = reviewNoticeSubscriptions(seller, admin);
  return { seen, all, named: (name: string) => all.find((item) => item.name === name)! };
}

describe('review notice subscriptions', () => {
  it('turns a visible review into a seller notice with the star count', async () => {
    const { seen, named } = subscriptions();
    await named(REVIEW_NOTICE_SUBSCRIBERS.sellerPosted).handle(
      { payload: { ...IDS, rating: 2 } } as never,
      delivery,
      context,
    );
    expect(seen.seller).toEqual([
      {
        delivery,
        item: {
          kind: 'seller.review-posted',
          owner: { by: 'seller', sellerId: IDS.sellerId },
          params: { reviewId: IDS.reviewId, productId: IDS.productId, rating: 2 },
        },
      },
    ]);
  });

  it('turns a hidden and a restored review into seller notices with two ids', async () => {
    const { seen, named } = subscriptions();
    for (const name of [
      REVIEW_NOTICE_SUBSCRIBERS.sellerHidden,
      REVIEW_NOTICE_SUBSCRIBERS.sellerRestored,
    ]) {
      await named(name).handle({ payload: IDS } as never, delivery, context);
    }
    expect(seen.seller).toEqual([
      {
        delivery,
        item: {
          kind: 'seller.review-hidden',
          owner: { by: 'seller', sellerId: IDS.sellerId },
          params: { reviewId: IDS.reviewId, productId: IDS.productId },
        },
      },
      {
        delivery,
        item: {
          kind: 'seller.review-restored',
          owner: { by: 'seller', sellerId: IDS.sellerId },
          params: { reviewId: IDS.reviewId, productId: IDS.productId },
        },
      },
    ]);
  });

  it('turns a delivery problem into a seller notice naming nothing', async () => {
    const { seen, named } = subscriptions();
    await named(REVIEW_NOTICE_SUBSCRIBERS.sellerDeliveryProblem).handle(
      { payload: { sellerId: IDS.sellerId } } as never,
      delivery,
      context,
    );
    expect(seen.seller).toEqual([
      {
        delivery,
        item: {
          kind: 'seller.delivery-problem',
          owner: { by: 'seller', sellerId: IDS.sellerId },
          params: {},
        },
      },
    ]);
  });

  it('turns a held and a reported review into admin notices with the review id only', async () => {
    const { seen, named } = subscriptions();
    await named(REVIEW_NOTICE_SUBSCRIBERS.adminHeld).handle(
      { payload: IDS } as never,
      delivery,
      context,
    );
    await named(REVIEW_NOTICE_SUBSCRIBERS.adminReported).handle(
      { payload: IDS } as never,
      delivery,
      context,
    );
    expect(seen.admin).toEqual([
      { delivery, item: { kind: 'admin.review-held', reviewId: IDS.reviewId } },
      { delivery, item: { kind: 'admin.review-reported', reviewId: IDS.reviewId } },
    ]);
  });

  it('throws a refusal so that the delivery is retried', async () => {
    const { all } = subscriptions(true);
    expect(all).toHaveLength(Object.keys(REVIEW_NOTICE_SUBSCRIBERS).length);
    for (const item of all) {
      await expect(
        item.handle({ payload: { ...IDS, rating: 1 } } as never, delivery, context),
      ).rejects.toThrow(/refused/);
    }
  });
});
