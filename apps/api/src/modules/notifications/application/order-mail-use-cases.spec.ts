import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { expectSystemOnly } from '../../../../test/support/system-only-denial';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { MailSendError, type MailMessage } from '../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CatalogFacade } from '../../catalog';
import type { ContactEmailTarget, IdentityFacade } from '../../identity';
import type { OrderingFacade, OrderNotice, ShipmentNotice } from '../../ordering';
import { ConfigNotificationsPolicy } from '../infrastructure/config-notifications-policy';
import type { OrderMailDependencies } from './order-mail-flow';
import { SendOrderConfirmationMail } from './use-cases/send-order-confirmation-mail.use-case';
import { SendOrderShippedMail } from './use-cases/send-order-shipped-mail.use-case';
import { SendSellerNewOrderMail } from './use-cases/send-seller-new-order-mail.use-case';
import { SendSellerOrderDisputedMail } from './use-cases/send-seller-order-disputed-mail.use-case';

// The two order emails in memory on both Market fixtures (AU in AUD, ZZ in JPY): who gets what,
// that no customer address reaches a seller, that names stay one plain line, that a send
// failure is thrown back to the outbox delivery (never to the payment), and that a repeated
// delivery is marked once.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ORDER = id<'Order'>(0x01);
const ACCOUNT = id<'Account'>(0xa1);
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const OFFER_1 = id<'Offer'>(0x11);
const OFFER_2 = id<'Offer'>(0x12);
const CUSTOMER_EMAIL = 'buyer.private@customer.example';
const OWNER_A = 'owner.a@seller-a.example';
const OWNER_B = 'owner.b@seller-b.example';

const NOTICE: OrderNotice = {
  orderId: ORDER,
  accountId: ACCOUNT,
  sellerOrders: [
    {
      sellerOrderId: id<'SellerOrder'>(0x21),
      sellerId: SELLER_A,
      lines: [{ offerId: OFFER_1, quantity: 2 }],
    },
    {
      sellerOrderId: id<'SellerOrder'>(0x22),
      sellerId: SELLER_B,
      lines: [{ offerId: OFFER_2, quantity: 1 }],
    },
  ],
};

const SHIPMENT: ShipmentNotice = {
  orderId: ORDER,
  accountId: ACCOUNT,
  sellerOrderId: id<'SellerOrder'>(0x21),
  carrier: 'Australia Post',
  trackingRef: 'AP123456789',
};

describe.each([['AU'], ['ZZ']] as const)('order emails in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'order-mail-0001');
  const anonymous = testCallContext(market, 'anonymous', 'order-mail-0002');

  let sent: MailMessage[];
  let sendError: Error | null;
  let notice: ReturnType<OrderingFacade['orderNotice']>;
  let shipment: ReturnType<OrderingFacade['shipmentNotice']>;
  let addresses: Map<string, string | null>;
  let names: Map<Id<'Offer'>, string>;
  let unitOfWork: FakeUnitOfWork;
  let deps: OrderMailDependencies;
  let nextEvent: number;

  const delivery = (subscriber: string, eventNo = 1): EventDelivery => ({
    eventId: id<'event'>(0xe0 + eventNo),
    subscriber,
    attempt: 1,
  });
  const keyOf = (target: ContactEmailTarget) =>
    target.kind === 'customer' ? target.accountId : target.sellerId;

  beforeEach(() => {
    sent = [];
    sendError = null;
    nextEvent = 1;
    notice = Promise.resolve(ok(NOTICE));
    shipment = Promise.resolve(ok(SHIPMENT));
    addresses = new Map<string, string | null>([
      [ACCOUNT, CUSTOMER_EMAIL],
      [SELLER_A, OWNER_A],
      [SELLER_B, OWNER_B],
    ]);
    names = new Map([
      [OFFER_1, 'Blue <b>Mug</b>\r\nBcc: attacker@evil.example'],
      [OFFER_2, 'Tea & "Biscuits"'],
    ]);
    unitOfWork = new FakeUnitOfWork();
    const ordering = {
      orderNotice: () => notice,
      shipmentNotice: () => shipment,
    } as unknown as OrderingFacade;
    const catalog = {
      offerNames: () => Promise.resolve(ok(names)),
    } as unknown as CatalogFacade;
    const identity = {
      contactEmailOf: (_context: CallContext, target: ContactEmailTarget) =>
        Promise.resolve(ok(addresses.get(keyOf(target)) ?? null)),
    } as unknown as IdentityFacade;
    deps = {
      unitOfWork,
      ordering,
      catalog,
      identity,
      transport: {
        send: (message) => {
          if (sendError !== null) return Promise.reject(sendError);
          sent.push(message);
          return Promise.resolve();
        },
      },
      policy: new ConfigNotificationsPolicy(markets),
    };
  });

  const confirmation = (eventNo = nextEvent++) =>
    new SendOrderConfirmationMail(gate, deps).execute(system, {
      delivery: delivery('notifications.order-confirmation-mail', eventNo),
      orderId: ORDER,
    });
  const sellerMails = (eventNo = nextEvent++) =>
    new SendSellerNewOrderMail(gate, deps).execute(system, {
      delivery: delivery('notifications.seller-new-order-mail', eventNo),
      orderId: ORDER,
    });

  describe('order confirmation (customer)', () => {
    it('is labelled "Order confirmation" and links to the order page by id only', async () => {
      const result = await confirmation();

      expect(result).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
      expect(sent).toHaveLength(1);
      const mail = sent[0]!;
      const sender = markets.get(market.marketId).identity.mail;
      expect(mail.to).toBe(CUSTOMER_EMAIL);
      expect(mail.from).toEqual({ address: sender.fromAddress, name: sender.fromName });
      expect(mail.subject).toBe('Order confirmation');
      expect(`${mail.subject}\n${mail.text}`).not.toMatch(/tax invoice/i);
      const page = markets.get(market.marketId).notifications?.customerOrderPage;
      expect(page).toBeDefined();
      expect(mail.text).toContain(`${page}/${ORDER}`);
      expect(mail.text).toContain(`Order reference: ${ORDER}`);
      // The link carries the order id and nothing else: no address, no token, no query.
      const link = /https?:\/\/\S+/.exec(mail.text)![0];
      expect(link).toBe(`${page}/${ORDER}`);
      expect(link).not.toMatch(/[?#@]/);
      expect(link).not.toContain(CUSTOMER_EMAIL);
    });

    it('lists every line with a one-line name and its quantity', async () => {
      await confirmation();
      const text = sent[0]!.text;

      expect(text).toContain('- Blue <b>Mug</b> Bcc: attacker@evil.example x 2');
      expect(text).toContain('- Tea & "Biscuits" x 1');
      // A seller-entered name never adds a line or a header to the message.
      expect(text.split('\n').filter((l) => l.startsWith('Bcc:'))).toEqual([]);
    });

    it('uses a plain fallback for a product without a name', async () => {
      names = new Map();
      await confirmation();
      expect(sent[0]!.text).toContain('- Item x 2');
    });

    it('sends nothing, and marks the delivery, when the customer has no usable address', async () => {
      addresses.set(ACCOUNT, null);
      const result = await confirmation();

      expect(result).toEqual(ok({ code: 'order-mail.skipped', reason: 'recipient.none' }));
      expect(sent).toEqual([]);
      expect(unitOfWork.handled.size).toBe(1);
    });

    it('sends nothing for an order that is gone, and none when the Market has no order page', async () => {
      notice = Promise.resolve(err({ code: 'ordering.order-not-found' as const }));
      expect(await confirmation()).toEqual(
        ok({ code: 'order-mail.skipped', reason: 'order.gone' }),
      );
      notice = Promise.resolve(ok(NOTICE));
      deps = {
        ...deps,
        policy: { ...deps.policy, customerOrderUrl: () => null },
      };
      expect(await confirmation()).toEqual(
        ok({ code: 'order-mail.skipped', reason: 'link.unconfigured' }),
      );
      expect(sent).toEqual([]);
    });

    it('throws a send failure back to the delivery, marks nothing and leaks no address', async () => {
      sendError = new MailSendError('mail.transport-unreachable');
      const attempt = confirmation();

      await expect(attempt).rejects.toThrow(MailSendError);
      await expect(attempt).rejects.not.toThrow(CUSTOMER_EMAIL);
      // Not handled: the outbox retries the delivery, and the retry sends.
      expect(unitOfWork.handled.size).toBe(0);
      sendError = null;
      expect(await confirmation(1)).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
    });

    it('marks a repeated delivery once', async () => {
      await confirmation(7);
      const again = await confirmation(7);
      expect(again).toEqual(ok({ code: 'order-mail.already-handled' }));
    });

    it('is for the system actor only', async () => {
      const denied = await new SendOrderConfirmationMail(gate, deps).execute(anonymous, {
        delivery: delivery('notifications.order-confirmation-mail'),
        orderId: ORDER,
      });
      expect(denied).toEqual(err({ code: 'access.denied' }));
      expect(sent).toEqual([]);
    });
  });

  describe('new order (sellers)', () => {
    it('sends one mail per seller order with only that seller’s lines', async () => {
      const result = await sellerMails();

      expect(result).toEqual(ok({ code: 'order-mail.sent', sent: 2 }));
      expect(sent.map((m) => m.to)).toEqual([OWNER_A, OWNER_B]);
      const [a, b] = sent as [MailMessage, MailMessage];
      expect(a.subject).toBe('New order');
      expect(a.text).toContain(`Order reference: ${NOTICE.sellerOrders[0]!.sellerOrderId}`);
      expect(a.text).toContain('Blue <b>Mug</b>');
      expect(a.text).not.toContain('Biscuits');
      expect(b.text).toContain('Tea & "Biscuits" x 1');
      expect(b.text).not.toContain('Mug');
    });

    it('never holds the customer’s address or account id, nor another seller’s address', async () => {
      await sellerMails();
      for (const mail of sent) {
        const everything = JSON.stringify(mail);
        expect(everything).not.toContain(CUSTOMER_EMAIL);
        expect(everything).not.toContain(ACCOUNT);
        expect(everything).not.toMatch(/https?:\/\//);
      }
      expect(JSON.stringify(sent[0])).not.toContain(OWNER_B);
      expect(JSON.stringify(sent[1])).not.toContain(OWNER_A);
    });

    it('skips a seller without a usable owner address and still mails the others', async () => {
      addresses.set(SELLER_A, null);
      const result = await sellerMails();

      expect(result).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
      expect(sent.map((m) => m.to)).toEqual([OWNER_B]);
    });

    it('tries every seller, then throws the failure back to the delivery', async () => {
      let calls = 0;
      deps = {
        ...deps,
        transport: {
          send: (message) => {
            calls += 1;
            if (message.to === OWNER_A)
              return Promise.reject(new MailSendError('mail.transport-timeout'));
            sent.push(message);
            return Promise.resolve();
          },
        },
      };

      await expect(sellerMails()).rejects.toThrow(/a send failed/);
      expect(calls).toBe(2);
      expect(sent.map((m) => m.to)).toEqual([OWNER_B]);
      expect(unitOfWork.handled.size).toBe(0);
    });

    it('is for the system actor only', async () => {
      const denied = await new SendSellerNewOrderMail(gate, deps).execute(anonymous, {
        delivery: delivery('notifications.seller-new-order-mail'),
        orderId: ORDER,
      });
      expect(denied).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('payment dispute (seller)', () => {
    const disputed = (sellerId: Id<'Seller'> = SELLER_A, eventNo = nextEvent++) =>
      new SendSellerOrderDisputedMail(gate, deps).execute(system, {
        delivery: delivery('notifications.seller-order-disputed-mail', eventNo),
        orderId: ORDER,
        sellerId,
      });

    it('mails the Owner of the seller the order reference, and nothing of the dispute', async () => {
      const result = await disputed();

      expect(result).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
      expect(sent.map((m) => m.to)).toEqual([OWNER_A]);
      expect(sent[0]!.subject).toBe('Payment dispute on an order');
      expect(sent[0]!.text).toContain(`A payment on order ${ORDER} was disputed.`);
      expect(sent[0]!.text).toContain('on hold until the dispute is closed');
      const everything = JSON.stringify(sent[0]);
      expect(everything).not.toContain(CUSTOMER_EMAIL);
      expect(everything).not.toContain(ACCOUNT);
      expect(everything).not.toContain(OWNER_B);
      expect(everything).not.toMatch(/fraud|card|bank|evidence|https?:\/\//i);
    });

    it('sends nothing when the seller has no usable owner address, and marks the delivery', async () => {
      addresses.set(SELLER_A, null);
      const result = await disputed();

      expect(result).toMatchObject({ ok: true });
      expect(sent).toEqual([]);
      expect(unitOfWork.handled.size).toBe(1);
    });

    it('throws a send failure back to the delivery and marks a repeat once', async () => {
      sendError = new MailSendError('mail.transport-timeout');
      await expect(disputed()).rejects.toThrow();
      expect(unitOfWork.handled.size).toBe(0);
      sendError = null;
      expect(await disputed(SELLER_A, 7)).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
      // Mail is at least once; the delivery itself is marked handled a single time.
      expect(await disputed(SELLER_A, 7)).toEqual(ok({ code: 'order-mail.already-handled' }));
      expect(unitOfWork.handled.size).toBe(1);
    });

    it('is for the system actor only', async () => {
      const denied = await new SendSellerOrderDisputedMail(gate, deps).execute(anonymous, {
        delivery: delivery('notifications.seller-order-disputed-mail'),
        orderId: ORDER,
        sellerId: SELLER_A,
      });
      expect(denied).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('shipped (customer)', () => {
    const shipped = (eventNo = nextEvent++, context = system) =>
      new SendOrderShippedMail(gate, deps).execute(context, {
        delivery: delivery('notifications.order-shipped-mail', eventNo),
        orderId: ORDER,
        sellerOrderId: SHIPMENT.sellerOrderId,
      });

    it('mails the customer the carrier, the tracking number and the order link', async () => {
      expect(await shipped()).toEqual(ok({ code: 'order-mail.sent', sent: 1 }));
      const mail = sent[0]!;
      const page = markets.get(market.marketId).notifications?.customerOrderPage;
      expect(mail.to).toBe(CUSTOMER_EMAIL);
      expect(mail.subject).toBe('Shipped');
      expect(mail.text).toContain('Carrier: Australia Post');
      expect(mail.text).toContain('Tracking number: AP123456789');
      expect(mail.text).toContain(`${page}/${ORDER}`);
    });

    it('leaves out the tracking line when the seller gave none, and flattens text to one line', async () => {
      shipment = Promise.resolve(
        ok({ ...SHIPMENT, carrier: 'Post\r\nBcc: a@evil.example', trackingRef: null }),
      );
      await shipped();
      const text = sent[0]!.text;
      expect(text).not.toContain('Tracking number');
      expect(text.split('\n').filter((l) => l.startsWith('Bcc:'))).toEqual([]);
    });

    it('sends nothing when the shipment is gone, there is no order page or no address', async () => {
      shipment = Promise.resolve(err({ code: 'ordering.order-not-found' as const }));
      expect(await shipped()).toEqual(ok({ code: 'order-mail.skipped', reason: 'order.gone' }));
      shipment = Promise.resolve(ok(SHIPMENT));
      addresses.set(ACCOUNT, null);
      expect(await shipped()).toEqual(ok({ code: 'order-mail.skipped', reason: 'recipient.none' }));
      addresses.set(ACCOUNT, CUSTOMER_EMAIL);
      deps = { ...deps, policy: { ...deps.policy, customerOrderUrl: () => null } };
      expect(await shipped()).toEqual(
        ok({ code: 'order-mail.skipped', reason: 'link.unconfigured' }),
      );
      expect(sent).toEqual([]);
    });

    it('throws a send failure back to the delivery and marks a repeat once', async () => {
      sendError = new MailSendError('mail.transport-unreachable');
      await expect(shipped(1)).rejects.toThrow(MailSendError);
      expect(unitOfWork.handled.size).toBe(0);
      sendError = null;
      await shipped(1);
      expect(await shipped(1)).toEqual(ok({ code: 'order-mail.already-handled' }));
    });

    it('is for the system actor only', async () => {
      await expectSystemOnly(code, (context) => shipped(1, context));
      expect(sent).toEqual([]);
    });
  });
});
