import { err, money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  AllowAllDeliveryMethods,
  FakeAttemptLimits,
  FakeCart,
  FakeCommission,
  FakeCustomers,
  FakeGateway,
  FakeInventory,
  FakeLabels,
  FakePickupVault,
  FakeShipping,
  FakeShipToCipher,
  FakeTax,
  FakeTaxCategories,
  MemoryOrders,
  MemoryPickupCodes,
  NO_AUDIT,
  NO_REFUNDS,
  TEST_DELIVERY_ADDRESS,
} from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CheckoutLine } from '../../cart';
import { PAYMENT_ATTEMPTS_PER_WINDOW } from '../domain/card-payment';
import { ConfigOrderingPolicy } from '../infrastructure/config-ordering-policy';
import type { OrderingDependencies } from './checkout-flow';
import { CancelPayment } from './use-cases/cancel-payment.use-case';
import { ConfirmPayment } from './use-cases/confirm-payment.use-case';
import { PayByCard } from './use-cases/pay-by-card.use-case';
import { StartCheckout } from './use-cases/start-checkout.use-case';

// Paying by card on the MondaPac page, in memory on both Market fixtures (AU in AUD, ZZ in JPY):
// the server prices the whole order, the card brand comes from Stripe, nothing is reserved when
// the total moved or the card is refused, every failure after the hold releases it, and the
// webhook path (confirm with no session) settles the order.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa1);
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const OFFER_1 = id<'Offer'>(0x01);
const OFFER_2 = id<'Offer'>(0x02);
const OFFER_3 = id<'Offer'>(0x03);
const VARIANT = id<'Variant'>(0x10);
const ADDRESS = id<'CustomerAddress'>(0xad);
const TOKEN = 'ctoken_1TestToken';

describe.each([['AU'], ['ZZ']] as const)('card payment in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: ACCOUNT,
      sessionId: id<'Session'>(0x61),
      sellerId: null,
    }),
    'order-0001-abcd',
  );
  const system = testCallContext(market, 'system', 'order-0002-abcd');

  let orders: MemoryOrders;
  let gateway: FakeGateway;
  let inventory: FakeInventory;
  let attempts: FakeAttemptLimits;
  let deps: OrderingDependencies;
  // 2 x 10.00 + 3 x 2.50 + 0.99 + A's 5.00 delivery (B delivers free).
  const TOTAL = 2000n + 750n + 99n + 500n;

  beforeEach(() => {
    orders = new MemoryOrders();
    gateway = new FakeGateway();
    inventory = new FakeInventory();
    attempts = new FakeAttemptLimits();
    const cart = new FakeCart();
    const shipping = new FakeShipping();
    const customers = new FakeCustomers();
    customers.addresses.set(ADDRESS, { accountId: ACCOUNT, address: TEST_DELIVERY_ADDRESS });
    shipping.quotedTotals.set(SELLER_A, money(500n, currency));
    shipping.quotedTotals.set(SELLER_B, money(0n, currency));
    shipping.pickupApproved = new Set([SELLER_A, SELLER_B]);
    const line = (
      offerId: Id<'Offer'>,
      sellerId: Id<'Seller'>,
      unit: bigint,
      quantity: number,
    ): CheckoutLine => ({
      offerId,
      variantId: VARIANT,
      quantity,
      state: 'buyable',
      sellerId,
      unitPrice: money(unit, currency),
      taxInclusive: true,
    });
    cart.lines = [
      line(OFFER_1, SELLER_A, 1000n, 2),
      line(OFFER_2, SELLER_B, 250n, 3),
      line(OFFER_3, SELLER_A, 99n, 1),
    ];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      orders,
      refunds: NO_REFUNDS,
      audit: NO_AUDIT,
      gateway,
      policy: new ConfigOrderingPolicy(markets),
      cart,
      customers,
      shipTo: new FakeShipToCipher(),
      inventory,
      shipping,
      commission: new FakeCommission(),
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories(code === 'AU' ? 'taxable' : 'zz_standard'),
      outbox: { append: () => Promise.resolve() },
      ids: new SequenceIdGenerator(clock),
      clock,
      labels: new FakeLabels(),
      deliveryMethods: new AllowAllDeliveryMethods(),
      pickupCodes: new MemoryPickupCodes(),
      pickupVault: new FakePickupVault(),
      attempts,
    };
  });

  const pay = (input: Record<string, unknown> = {}, context: CallContext = customer) =>
    new PayByCard(gate, deps).execute(context, {
      addressId: ADDRESS,
      confirmationToken: TOKEN,
      ...input,
    });
  const onlyOrder = () => [...orders.rows.values()][0]!;

  it('authorises the card for the total the server computed and links the PaymentIntent', async () => {
    const paid = await pay();

    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.value).toMatchObject({ status: 'authorised', clientSecret: null });
    expect(paid.value.total).toEqual(money(TOTAL, currency));
    const order = orders.rows.get(paid.value.orderId)!;
    expect(order).toMatchObject({
      status: 'pending-payment',
      paymentState: 'none',
      stripeSessionId: null,
      stripePaymentIntentId: 'pi_card_1',
    });
    // The request to Stripe carries the order's own amount and key, never anything from the client.
    expect(gateway.cardPayments).toEqual([
      expect.objectContaining({
        orderId: order.id,
        marketId: code,
        currency,
        amount: TOTAL,
        confirmationToken: TOKEN,
        idempotencyKey: `checkout-${order.id}`,
      }),
    ]);
    expect(gateway.cardPayments[0]!.returnUrl).toContain(order.id);
    expect(gateway.sessions).toEqual([]);
    expect(gateway.tokenReads).toEqual([TOKEN]);
    expect(inventory.calls).toEqual(['reserve']);
    expect(gateway.captured).toEqual([]);
  });

  it('hands the browser the client secret when the bank asks for 3DS, and nothing else of the card', async () => {
    gateway.cardStatus = 'requires-action';

    const paid = await pay();

    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.value).toMatchObject({
      status: 'requires-action',
      clientSecret: 'pi_card_1_secret_test',
    });
    expect(onlyOrder()).toMatchObject({
      status: 'pending-payment',
      stripePaymentIntentId: 'pi_card_1',
    });
    expect(gateway.captured).toEqual([]);
  });

  it('keeps a payment a webhook confirmed between the PaymentIntent and the link', async () => {
    // The signed event lands after Stripe answered but before the order is linked: the first save
    // is stale. The order is read again, already holds this PaymentIntent, and nothing is undone.
    const realSave = orders.save.bind(orders);
    let raced = false;
    orders.save = (m, order) => {
      if (!raced && order.stripePaymentIntentId === 'pi_card_1') {
        raced = true;
        const stored = orders.rows.get(order.id)!;
        orders.rows.set(order.id, {
          ...stored,
          stripePaymentIntentId: 'pi_card_1',
          paymentState: 'authorised',
          version: stored.version + 1,
        });
      }
      return realSave(m, order);
    };

    const paid = await pay();

    expect(paid.ok).toBe(true);
    expect(raced).toBe(true);
    expect(gateway.voided).toEqual([]);
    expect(inventory.calls).toEqual(['reserve']);
    expect(onlyOrder()).toMatchObject({
      status: 'pending-payment',
      paymentState: 'authorised',
      stripePaymentIntentId: 'pi_card_1',
    });
  });

  it('still undoes the payment when the order cannot be linked after the retries', async () => {
    orders.save = () => Promise.resolve('stale' as const);

    const paid = await pay();

    expect(paid).toEqual(err({ code: 'conflict.retry' }));
    expect(gateway.voided).toEqual([['pi_card_1', 'void-pi_card_1']]);
    expect(inventory.calls).toEqual(['reserve', 'release-own']);
  });

  it('accepts the total the buyer saw when it equals the server total', async () => {
    const paid = await pay({ expectedTotal: { amount: TOTAL.toString(), currency } });

    expect(paid.ok).toBe(true);
  });

  it('refuses a total that moved before reserving or calling Stripe, and says the new total', async () => {
    const paid = await pay({ expectedTotal: { amount: '1', currency } });

    expect(paid).toEqual(err({ code: 'ordering.price-changed', total: money(TOTAL, currency) }));
    expect(inventory.calls).toEqual([]);
    expect(gateway.cardPayments).toEqual([]);
    expect(orders.rows.size).toBe(0);
  });

  it.each([
    ['an American Express card', { livemode: false, methodType: 'card', cardBrand: 'amex' }],
    ['a card of an unknown brand', { livemode: false, methodType: 'card', cardBrand: null }],
    [
      'a method that is not a card',
      { livemode: false, methodType: 'au_becs_debit', cardBrand: null },
    ],
    ['a live-mode token', { livemode: true, methodType: 'card', cardBrand: 'visa' }],
  ])('refuses %s before anything is reserved', async (_name, facts) => {
    gateway.tokenFacts = facts;

    const paid = await pay();

    expect(paid).toEqual(err({ code: 'ordering.card-not-accepted' }));
    expect(inventory.calls).toEqual([]);
    expect(gateway.cardPayments).toEqual([]);
    expect(orders.rows.size).toBe(0);
  });

  it.each(['visa', 'mastercard'])('accepts a %s card', async (cardBrand) => {
    gateway.tokenFacts = { livemode: false, methodType: 'card', cardBrand };

    expect((await pay()).ok).toBe(true);
  });

  it.each([
    ['no token', { confirmationToken: undefined }, 'required'],
    ['a payment method id instead of a token', { confirmationToken: 'pm_1234' }, 'format'],
    ['a token with a path in it', { confirmationToken: 'ctoken_a/../b' }, 'format'],
  ])('refuses %s without calling anyone', async (_name, input, code2) => {
    const paid = await pay(input);

    expect(paid).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'confirmationToken', code: code2 }] }),
    );
    expect(gateway.tokenReads).toEqual([]);
    expect(inventory.calls).toEqual([]);
  });

  it('refuses a malformed expected total', async () => {
    const paid = await pay({ expectedTotal: { amount: '-5', currency } });

    expect(paid).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'expectedTotal', code: 'format' }] }),
    );
    expect(inventory.calls).toEqual([]);
  });

  it('says the token is invalid when Stripe does not know it, and unavailable when it cannot be read', async () => {
    gateway.tokenReadFails = { code: 'payment.provider-rejected' };
    expect(await pay()).toEqual(
      err({
        code: 'validation.failed',
        fields: [{ path: 'confirmationToken', code: 'invalid' }],
      }),
    );

    gateway.tokenReadFails = { code: 'payment.provider-unavailable' };
    expect(await pay()).toEqual(err({ code: 'ordering.payment-unavailable' }));
    expect(inventory.calls).toEqual([]);
  });

  it('cancels the order, releases the stock and stops the PaymentIntent when the bank declines', async () => {
    gateway.cardFails = { code: 'payment.card-declined', paymentIntentId: 'pi_declined_1' };

    const paid = await pay();

    expect(paid).toEqual(err({ code: 'ordering.card-declined' }));
    expect(onlyOrder()).toMatchObject({ status: 'cancelled', cancelReason: 'provider-failed' });
    expect(inventory.calls).toEqual(['reserve', 'release-own']);
    expect(gateway.voided).toEqual([['pi_declined_1', 'void-pi_declined_1']]);
    expect(gateway.captured).toEqual([]);
  });

  it('cancels the order and releases the stock when Stripe cannot be reached', async () => {
    gateway.cardFails = { code: 'payment.provider-unavailable' };

    const paid = await pay();

    expect(paid).toEqual(err({ code: 'ordering.payment-unavailable' }));
    expect(onlyOrder()).toMatchObject({ status: 'cancelled', cancelReason: 'provider-failed' });
    expect(inventory.calls).toEqual(['reserve', 'release-own']);
  });

  it('stops the earlier unpaid card payment when a new attempt supersedes it', async () => {
    const first = await pay();
    const second = await pay();

    expect(first.ok && second.ok).toBe(true);
    const [one, two] = [...orders.rows.values()];
    expect(one).toMatchObject({ status: 'cancelled', cancelReason: 'superseded' });
    expect(two).toMatchObject({ status: 'pending-payment', stripePaymentIntentId: 'pi_card_2' });
    expect(gateway.voided).toEqual([['pi_card_1', 'void-pi_card_1']]);
  });

  it('allows a few attempts per window, then throttles with the time left', async () => {
    for (let n = 0; n < PAYMENT_ATTEMPTS_PER_WINDOW; n += 1) {
      gateway.tokenFacts = { livemode: false, methodType: 'card', cardBrand: 'amex' };
      expect(await pay()).toEqual(err({ code: 'ordering.card-not-accepted' }));
    }

    expect(await pay()).toEqual(err({ code: 'request.throttled', retryAfterSeconds: 120 }));
    expect(gateway.tokenReads).toHaveLength(PAYMENT_ATTEMPTS_PER_WINDOW);
  });

  it('counts per account and Market, and fails closed when the counter is down', async () => {
    await pay();
    expect([...attempts.counts.keys()]).toEqual([`${code}:${ACCOUNT}`]);

    attempts.breaks = true;
    expect(await pay()).toEqual(err({ code: 'access.unavailable' }));
    expect(gateway.tokenReads).toHaveLength(1);
  });

  it('is for a signed-in customer only', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'order-0003-abcd');

    const paid = await pay({}, anonymous);

    expect(paid.ok).toBe(false);
    expect(gateway.tokenReads).toEqual([]);
    expect(orders.rows.size).toBe(0);
  });

  describe('settling the payment (the webhook path)', () => {
    const confirm = (orderId: string, over: Record<string, unknown> = {}) =>
      new ConfirmPayment(gate, deps).execute(system, {
        orderId,
        paymentIntentId: 'pi_card_1',
        sessionId: null,
        amount: money(TOTAL, currency),
        card: { methodType: 'card', brand: 'mastercard' },
        ...over,
      });

    it('commits the stock, captures and confirms an order with no session', async () => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const confirmed = await confirm(paid.value.orderId);

      expect(confirmed.ok && confirmed.value).toBe('confirmed');
      expect(inventory.calls).toEqual(['reserve', 'commit']);
      expect(gateway.captured).toEqual([['pi_card_1', `capture-${paid.value.orderId}`]]);
      expect(orders.rows.get(paid.value.orderId)).toMatchObject({
        status: 'confirmed',
        paymentState: 'captured',
        stripePaymentIntentId: 'pi_card_1',
      });
      // A repeated delivery changes nothing.
      const again = await confirm(paid.value.orderId);
      expect(again.ok && again.value).toBe('already-confirmed');
      expect(gateway.captured).toHaveLength(1);
    });

    it.each([
      ['an American Express card swapped in during 3DS', { methodType: 'card', brand: 'amex' }],
      ['a method that is not a card', { methodType: 'au_becs_debit', brand: null }],
      ['a method that could not be read', { methodType: '', brand: null }],
      ['no card facts at all', null],
    ])('voids the hold and cancels the order for %s, never capturing it', async (_name, card) => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const settled = await confirm(paid.value.orderId, { card });

      expect(settled.ok && settled.value).toBe('voided');
      expect(gateway.voided).toEqual([['pi_card_1', 'void-pi_card_1']]);
      expect(gateway.captured).toEqual([]);
      expect(inventory.calls).not.toContain('commit');
      expect(orders.rows.get(paid.value.orderId)).toMatchObject({ status: 'cancelled' });
    });

    it('voids a different PaymentIntent for the same order instead of taking two payments', async () => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const other = await confirm(paid.value.orderId, { paymentIntentId: 'pi_other_9' });

      expect(other.ok && other.value).toBe('voided');
      expect(gateway.voided).toEqual([['pi_other_9', 'void-pi_other_9']]);
      expect(gateway.captured).toEqual([]);
      // The order keeps the PaymentIntent it was linked to.
      expect(orders.rows.get(paid.value.orderId)).toMatchObject({
        status: 'pending-payment',
        stripePaymentIntentId: 'pi_card_1',
      });
    });

    it('voids money whose amount differs from the order total, never captures it', async () => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const short = await confirm(paid.value.orderId, { amount: money(TOTAL - 1n, currency) });

      expect(short.ok && short.value).toBe('voided');
      expect(gateway.captured).toEqual([]);
      expect(inventory.calls).not.toContain('commit');
    });

    it('does not let a session-less payment confirm an order of the hosted page', async () => {
      const hosted = await new StartCheckout(gate, deps).execute(customer, { addressId: ADDRESS });
      if (!hosted.ok) throw new Error('checkout failed');

      const refused = await confirm(hosted.value.orderId);

      expect(refused).toEqual(err({ code: 'validation.failed' }));
      expect(gateway.captured).toEqual([]);
    });

    it('does not let a session payment confirm a card order', async () => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const refused = await confirm(paid.value.orderId, { sessionId: 'cs_test_1' });

      expect(refused).toEqual(err({ code: 'validation.failed' }));
      expect(gateway.captured).toEqual([]);
    });

    it('cancels the order and stops the PaymentIntent when the payment failed', async () => {
      const paid = await pay();
      if (!paid.ok) throw new Error('pay failed');

      const cancelled = await new CancelPayment(gate, deps).execute(system, {
        orderId: paid.value.orderId,
        cause: 'payment-failed',
      });

      expect(cancelled.ok && cancelled.value).toBe('cancelled');
      expect(orders.rows.get(paid.value.orderId)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'payment-failed',
      });
      expect(gateway.voided).toEqual([['pi_card_1', 'void-pi_card_1']]);
      expect(inventory.calls).toContain('release:payment-failed');
    });
  });
});
