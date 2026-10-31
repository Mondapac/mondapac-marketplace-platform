import { ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { RecordAdminReviewNotice } from '../../application/use-cases/record-admin-review-notice.use-case';
import type { RecordSellerNotice } from '../../application/use-cases/record-seller-notice.use-case';
import {
  ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER,
  payoutNoticeSubscriptions,
  SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER,
} from './payout-notice.subscriptions';

// The two notices of the payout run (package 6d): terms changed (seller) and a reinstated seller
// whose payouts stay on hold (admin). Ids only; a refusal is thrown so the delivery is retried.

const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const IDS = {
  sellerId: '01990000-0000-7000-8000-000000000051',
  changeId: '01990000-0000-7000-8000-0000000000c1',
  decisionId: '01990000-0000-7000-8000-0000000000d1',
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
  const all = payoutNoticeSubscriptions(seller, admin);
  return { seen, named: (name: string) => all.find((item) => item.name === name)! };
}

describe('payout notice subscriptions', () => {
  it('turns a terms change into a seller notice without the change id', async () => {
    const { seen, named } = subscriptions();
    await named(SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER).handle(
      { payload: { sellerId: IDS.sellerId, changeId: IDS.changeId } } as never,
      delivery,
      context,
    );
    expect(seen.seller).toEqual([
      {
        delivery,
        item: {
          kind: 'seller.payout-terms-changed',
          owner: { by: 'seller', sellerId: IDS.sellerId },
          params: {},
        },
      },
    ]);
  });

  it('turns a remaining hold into an admin notice with the seller id only', async () => {
    const { seen, named } = subscriptions();
    await named(ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER).handle(
      { payload: { sellerId: IDS.sellerId, decisionId: IDS.decisionId } } as never,
      delivery,
      context,
    );
    expect(seen.admin).toEqual([
      { delivery, item: { kind: 'admin.seller-reinstated-hold-remains', sellerId: IDS.sellerId } },
    ]);
  });

  it('throws a refusal so that the delivery is retried', async () => {
    const { named } = subscriptions(true);
    for (const name of [
      SELLER_PAYOUT_TERMS_NOTICE_SUBSCRIBER,
      ADMIN_REINSTATED_HOLD_NOTICE_SUBSCRIBER,
    ]) {
      await expect(
        named(name).handle({ payload: IDS } as never, delivery, context),
      ).rejects.toThrow(/refused/);
    }
  });
});
