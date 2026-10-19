import { ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import type {
  RecordSellerNotice,
  RecordSellerNoticeInput,
} from '../../application/use-cases/record-seller-notice.use-case';
import type { RecordSellerOrderNotices } from '../../application/use-cases/record-seller-order-notices.use-case';
import { inAppNoticeSubscriptions, SELLER_NOTICE_SUBSCRIBERS } from './in-app-notice.subscriptions';

// The seller notice subscriptions (package 4): each event becomes one item for its seller, with
// ids and enums only; a superseded hold and a PLATFORM product's revision make none.

const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const OFFER = '01990000-0000-7000-8000-000000000031';
const PRODUCT = '01990000-0000-7000-8000-000000000071';

function subscriptions() {
  const inputs: RecordSellerNoticeInput[] = [];
  const sellerNotices = {
    execute: (_context: unknown, input: RecordSellerNoticeInput) => {
      inputs.push(input);
      return Promise.resolve(ok({ code: 'notices.recorded', notices: 1 }));
    },
  };
  const all = inAppNoticeSubscriptions(
    {} as RecordSellerOrderNotices,
    {} as RecordAdminReviewNotice,
    sellerNotices as unknown as RecordSellerNotice,
  );
  /** The handler of one subscriber, called as the dispatcher calls it. */
  const named = (name: string) => {
    const found = all.find((item) => item.name === name)!;
    return {
      handle: (event: never, delivery: EventDelivery, context: SubscriberContext) =>
        found.handle(event, delivery, context),
    };
  };
  return { all, inputs, named };
}

describe('seller notice subscriptions', () => {
  it('subscribes once per event, under the names of the inbox', () => {
    const { all } = subscriptions();
    for (const name of Object.values(SELLER_NOTICE_SUBSCRIBERS)) {
      expect(all.filter((item) => item.name === name)).toHaveLength(1);
    }
  });

  it("turns a held price's decision into a notice for the Offer's seller", async () => {
    const { inputs, named } = subscriptions();
    const handle = named(SELLER_NOTICE_SUBSCRIBERS.priceHoldDecided).handle;
    const payload = { offerId: OFFER, variantId: 'v', recordId: 'r', kind: 'special' };
    await handle({ payload: { ...payload, outcome: 'approved' } } as never, delivery, context);
    await handle({ payload: { ...payload, outcome: 'superseded' } } as never, delivery, context);
    expect(inputs.map((input) => input.item)).toEqual([
      {
        kind: 'seller.price-hold-decided',
        owner: { by: 'offer', offerId: OFFER },
        params: {
          offerId: OFFER,
          variantId: 'v',
          recordId: 'r',
          outcome: 'approved',
          priceKind: 'special',
        },
      },
    ]);
  });

  it("tells a seller about its own product's revision, never about a PLATFORM one", async () => {
    const { inputs, named } = subscriptions();
    const handle = named(SELLER_NOTICE_SUBSCRIBERS.productChangesRequested).handle;
    const payload = { productId: PRODUCT, revisionId: 'r', reasonCode: 'content-unclear' };
    await handle({ payload: { ...payload, scope: 'platform' } } as never, delivery, context);
    await handle({ payload: { ...payload, scope: 'seller' } } as never, delivery, context);
    expect(inputs.map((input) => input.item)).toEqual([
      {
        kind: 'seller.product-changes-requested',
        owner: { by: 'product', productId: PRODUCT },
        params: { productId: PRODUCT, revisionId: 'r', reason: 'content-unclear' },
      },
    ]);
  });

  it('keeps the outcome a certificate event stands for', async () => {
    const { inputs, named } = subscriptions();
    const payload = { sellerCertificationId: 'c', sellerId: 's', submissionId: 'x' };
    await named(SELLER_NOTICE_SUBSCRIBERS.certificateDeclined).handle(
      { payload } as never,
      delivery,
      context,
    );
    await named(SELLER_NOTICE_SUBSCRIBERS.certificateRevoked).handle(
      { payload: { ...payload, typeId: 't' } } as never,
      delivery,
      context,
    );
    expect(inputs.map((input) => [input.item.kind, input.item.params])).toEqual([
      ['seller.certificate-decided', { sellerCertificationId: 'c', outcome: 'declined' }],
      ['seller.certificate-ended', { sellerCertificationId: 'c', cause: 'revoked' }],
    ]);
  });

  it('throws when the use case refuses', async () => {
    const all = inAppNoticeSubscriptions(
      {} as never,
      {} as never,
      {
        execute: () => Promise.resolve({ ok: false, error: { code: 'access.denied' } }),
      } as unknown as RecordSellerNotice,
    );
    const lowStock = all.find((item) => item.name === SELLER_NOTICE_SUBSCRIBERS.lowStock)!;
    await expect(
      lowStock.handle(
        { payload: { sellerId: 's', offerId: 'o', variantId: 'v', onlyLeft: 1 } } as never,
        delivery,
        context,
      ),
    ).rejects.toThrow(/refused/);
  });
});
