import { ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type {
  RecordSellerNotice,
  RecordSellerNoticeInput,
} from '../../application/use-cases/record-seller-notice.use-case';
import type { SendSellerOrderDisputedMail } from '../../application/use-cases/send-seller-order-disputed-mail.use-case';
import {
  disputeNoticeSubscriptions,
  SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER,
  SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER,
} from './dispute-notice.subscriptions';

// The two subscriptions to `commission-payouts.seller-order-disputed.v1` (package 8b, D8): a seller
// notice and a mail, each with ids only. A refusal is thrown, so the delivery is retried.

const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const IDS = {
  sellerOrderId: '01990000-0000-7000-8000-000000000021',
  sellerId: '01990000-0000-7000-8000-000000000051',
  orderId: '01990000-0000-7000-8000-000000000001',
  disputeId: '01990000-0000-7000-8000-0000000000d1',
};

function subscriptions(
  answer: { ok: true } | { ok: false; error: { code: string } } = { ok: true },
) {
  const notices: RecordSellerNoticeInput[] = [];
  const mails: unknown[] = [];
  const notice = {
    execute: (_context: unknown, input: RecordSellerNoticeInput) => {
      notices.push(input);
      return Promise.resolve(answer.ok ? ok({ code: 'notices.recorded', notices: 1 }) : answer);
    },
  } as unknown as RecordSellerNotice;
  const mail = {
    execute: (_context: unknown, input: unknown) => {
      mails.push(input);
      return Promise.resolve(answer.ok ? ok({ code: 'order-mail.sent', sent: 1 }) : answer);
    },
  } as unknown as SendSellerOrderDisputedMail;
  const all = disputeNoticeSubscriptions(notice, mail);
  const named = (name: string) => all.find((item) => item.name === name)!;
  return { all, notices, mails, named };
}

describe('seller-order-disputed subscriptions', () => {
  it('subscribes once per handler, under the names of the inbox', () => {
    const { all } = subscriptions();
    expect(all.map((item) => item.name).sort()).toEqual(
      [SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER, SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER].sort(),
    );
  });

  it('turns the event into a seller notice with the two ids and nothing else', async () => {
    const { notices, named } = subscriptions();
    await named(SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER).handle(
      { payload: IDS } as never,
      delivery,
      context,
    );
    expect(notices.map((n) => n.item)).toEqual([
      {
        kind: 'seller.order-disputed',
        owner: { by: 'seller', sellerId: IDS.sellerId },
        params: { sellerOrderId: IDS.sellerOrderId, orderId: IDS.orderId },
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain(IDS.disputeId);
  });

  it('sends the mail for the order and seller of the event', async () => {
    const { mails, named } = subscriptions();
    await named(SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER).handle(
      { payload: IDS } as never,
      delivery,
      context,
    );
    expect(mails).toEqual([{ delivery, orderId: IDS.orderId, sellerId: IDS.sellerId }]);
  });

  it('throws a refusal, so that the delivery is retried', async () => {
    const { named } = subscriptions({ ok: false, error: { code: 'notices.try-again' } });
    for (const name of [
      SELLER_ORDER_DISPUTED_NOTICE_SUBSCRIBER,
      SELLER_ORDER_DISPUTED_MAIL_SUBSCRIBER,
    ]) {
      await expect(
        named(name).handle({ payload: IDS } as never, delivery, context),
      ).rejects.toThrow(/refused/);
    }
  });
});
