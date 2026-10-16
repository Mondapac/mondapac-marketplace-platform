import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeCart,
  FakeGateway,
  FakeInventory,
  FakeCommission,
  FakeLabels,
  FakeShipping,
  MemoryOrders,
} from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { OutboxWriteRefusedError } from '../../../platform/events/outbox-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CheckoutLine } from '../../cart';
import { ConfigOrderingPolicy } from '../infrastructure/config-ordering-policy';
import type { OrderingDependencies } from './checkout-flow';
import { AdminListOrders } from './use-cases/admin-list-orders.use-case';
import { AdminViewOrder } from './use-cases/admin-view-order.use-case';
import { CancelPayment } from './use-cases/cancel-payment.use-case';
import { ConfirmPayment } from './use-cases/confirm-payment.use-case';
import { ListOrders } from './use-cases/list-orders.use-case';
import { ShipmentNoticeQuery } from './use-cases/shipment-notice.use-case';
import { StartCheckout } from './use-cases/start-checkout.use-case';
import { RecordLedger } from './use-cases/record-ledger.use-case';
import { RecordShipments } from './use-cases/record-shipments.use-case';
import { SellerDeliverOrder } from './use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from './use-cases/seller-list-orders.use-case';
import { SellerShipOrder } from './use-cases/seller-ship-order.use-case';
import { SellerViewOrder } from './use-cases/seller-view-order.use-case';
import { ViewOrder } from './use-cases/view-order.use-case';

// Checkout, payment confirmation and the order reads in memory on both Market fixtures (AU in
// AUD, ZZ in JPY): the seller split and totals, stock reserved before the page opens, committed
// before the money is captured, every failure releasing what it took, and repeats changing nothing.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa1);
const OTHER = id<'Account'>(0xa2);
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const OFFER_1 = id<'Offer'>(0x01);
const OFFER_2 = id<'Offer'>(0x02);
const OFFER_3 = id<'Offer'>(0x03);
const VARIANT = id<'Variant'>(0x10);

describe.each([['AU'], ['ZZ']] as const)('ordering use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const customerOf = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'order-0001-abcd',
    );
  const customer = customerOf(ACCOUNT);
  const system = testCallContext(market, 'system', 'order-0002-abcd');
  const anonymous = testCallContext(market, 'anonymous', 'order-0003-abcd');

  let orders: MemoryOrders;
  let gateway: FakeGateway;
  let inventory: FakeInventory;
  let cart: FakeCart;
  let shipping: FakeShipping;
  let commission: FakeCommission;
  let labels: FakeLabels;
  let deps: OrderingDependencies;
  let written: PendingEvent[];

  const line = (
    offerId: Id<'Offer'>,
    sellerId: Id<'Seller'>,
    unit: bigint,
    quantity: number,
    overrides: Partial<CheckoutLine> = {},
  ): CheckoutLine => ({
    offerId,
    variantId: VARIANT,
    quantity,
    state: 'buyable',
    sellerId,
    unitPrice: money(unit, currency),
    taxInclusive: true,
    ...overrides,
  });

  beforeEach(() => {
    orders = new MemoryOrders();
    gateway = new FakeGateway();
    inventory = new FakeInventory();
    cart = new FakeCart();
    shipping = new FakeShipping();
    commission = new FakeCommission();
    labels = new FakeLabels();
    written = [];
    // Seller A charges a flat 5.00 for delivery; seller B delivers free (an explicit zero).
    shipping.fees.set(SELLER_A, money(500n, currency));
    shipping.fees.set(SELLER_B, money(0n, currency));
    cart.lines = [
      line(OFFER_1, SELLER_A, 1000n, 2),
      line(OFFER_2, SELLER_B, 250n, 3),
      line(OFFER_3, SELLER_A, 99n, 1),
    ];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      orders,
      gateway,
      policy: new ConfigOrderingPolicy(markets),
      cart,
      inventory,
      shipping,
      commission,
      outbox: {
        append: (_context, events) => {
          written.push(...events);
          return Promise.resolve();
        },
      },
      ids: new SequenceIdGenerator(clock),
      clock,
      labels,
    };
  });

  const start = (context: CallContext = customer) =>
    new StartCheckout(gate, deps).execute(context, {});
  /** A pending order from the default cart, read back from the store. */
  const placed = async () => {
    const result = await start();
    if (!result.ok) throw new Error('checkout failed');
    return orders.rows.get(result.value.orderId)!;
  };
  const confirm = (orderId: string, amount?: bigint, paymentIntentId = 'pi_test_1') =>
    new ConfirmPayment(gate, deps).execute(system, {
      orderId,
      paymentIntentId,
      sessionId: 'cs_test_1',
      amount: money(amount ?? [...orders.rows.values()][0]!.total.amount, currency),
    });

  describe('start-checkout', () => {
    it('splits the cart by seller, totals it, reserves the stock and opens the payment page', async () => {
      const started = await start();

      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.checkoutUrl).toBe('https://checkout.stripe.test/c/cs_test_1');
      expect(started.value.total).toEqual(money(2000n + 750n + 99n + 500n, currency));
      expect(started.value.payBy.epochMilliseconds).toBe(T0.add({ minutes: 30 }).epochMilliseconds);

      const order = orders.rows.get(started.value.orderId)!;
      expect(order).toMatchObject({
        status: 'pending-payment',
        paymentState: 'none',
        accountId: ACCOUNT,
        stripeSessionId: 'cs_test_1',
        stripeIdempotencyKey: `checkout-${order.id}`,
      });
      // Two sellers, each with its own subtotal and flat delivery fee (B's is an explicit zero).
      expect(order.sellerOrders.map((s) => [s.sellerId, s.subtotal, s.shipping, s.total])).toEqual([
        [SELLER_A, 2099n, 500n, 2599n],
        [SELLER_B, 750n, 0n, 750n],
      ]);
      expect(order.lines).toHaveLength(3);
      expect(
        order.lines.every((l) => l.lineAmount === l.unitPrice.amount * BigInt(l.quantity)),
      ).toBe(true);
      // The reservation is made for the order id and covers every line; nothing is committed yet.
      expect(inventory.reserved[0]?.checkoutRef).toBe(order.id);
      expect(inventory.reserved[0]?.lines).toHaveLength(3);
      expect(inventory.calls).toEqual(['reserve']);
      // The page: manual capture is the adapter's job; here, one package per seller, return pages.
      const session = gateway.sessions[0]!;
      // Goods per seller, then A's delivery; B's free delivery is no line (Stripe takes no zero price).
      expect(session.packages.map((p) => p.amount)).toEqual([2099n, 500n, 750n]);
      expect(session.packages.map((p) => p.label)).toEqual([
        'MondaPac order, package 1',
        'Delivery, package 1',
        'MondaPac order, package 2',
      ]);
      expect(session.currency).toBe(currency);
      expect(session.idempotencyKey).toBe(order.stripeIdempotencyKey);
      expect(session.successUrl).toMatch(/^https:\/\/storefront\..+\/checkout\/success\?order=/);
      expect(session.successUrl).toContain(order.id);
      expect(cart.cleared).toEqual([]);
    });

    it('refuses an empty cart and a line that cannot be bought, taking nothing', async () => {
      cart.lines = [];
      expect(await start()).toEqual(err({ code: 'ordering.cart-empty' }));

      cart.lines = [
        line(OFFER_1, SELLER_A, 1000n, 1),
        line(OFFER_2, SELLER_B, 250n, 1, { state: 'unavailable', unitPrice: null }),
      ];
      expect(await start()).toEqual(
        err({ code: 'ordering.cart-not-purchasable', lineIndexes: [1] }),
      );

      cart.down = true;
      expect(await start()).toEqual(err({ code: 'ordering.check-unavailable' }));
      cart.down = false;
      const sellers = [
        { sellerId: SELLER_A, reason: 'below-minimum' as const, minimum: money(4000n, currency) },
      ];
      cart.notReady = { code: 'cart.not-ready', details: { sellers } };
      expect(await start()).toEqual(err({ code: 'ordering.cart-not-ready', sellers }));
      expect(inventory.calls).toEqual([]);
      expect(orders.rows.size).toBe(0);
    });

    it('refuses a cart that mixes currencies or carries a free line', async () => {
      cart.lines = [
        line(OFFER_1, SELLER_A, 1000n, 1),
        line(OFFER_2, SELLER_B, 250n, 1, {
          unitPrice: money(250n, currency === 'AUD' ? 'JPY' : 'AUD'),
        }),
        line(OFFER_3, SELLER_B, 0n, 1),
      ];
      expect(await start()).toEqual(
        err({ code: 'ordering.cart-not-purchasable', lineIndexes: [1, 2] }),
      );
    });

    it('answers the stock refusal per line and stores no order', async () => {
      inventory.reserveFails = {
        code: 'inventory.insufficient',
        details: { lines: [{ offerId: OFFER_2, variantId: VARIANT, reason: 'not-enough' }] },
      };
      const refused = await start();

      expect(refused).toEqual(
        err({
          code: 'ordering.stock-insufficient',
          lines: [{ offerId: OFFER_2, variantId: VARIANT, reason: 'not-enough' }],
        }),
      );
      expect(orders.rows.size).toBe(0);
      expect(gateway.sessions).toEqual([]);
    });

    it('passes the rate limit through and retries a lock timeout once only', async () => {
      inventory.reserveFails = { code: 'request.throttled', retryAfterSeconds: 120 };
      expect(await start()).toEqual(err({ code: 'request.throttled', retryAfterSeconds: 120 }));
      expect(inventory.calls).toEqual(['reserve']);

      inventory.calls = [];
      inventory.reserveFails = { code: 'conflict.retry' };
      inventory.reserveFailuresLeft = 5;
      expect(await start()).toEqual(err({ code: 'conflict.retry' }));
      expect(inventory.calls).toEqual(['reserve', 'reserve']);

      inventory.calls = [];
      inventory.reserveFailuresLeft = 1;
      expect((await start()).ok).toBe(true);
      expect(inventory.calls).toEqual(['reserve', 'reserve']);
    });

    it('releases the hold and cancels the order when the payment page cannot be opened', async () => {
      gateway.createFails = { code: 'payment.provider-unavailable' };
      const refused = await start();

      expect(refused).toEqual(err({ code: 'ordering.payment-unavailable' }));
      expect(inventory.calls).toEqual(['reserve', 'release-own']);
      const [order] = [...orders.rows.values()];
      expect(order).toMatchObject({ status: 'cancelled', cancelReason: 'provider-failed' });
    });

    it('cancels the earlier unpaid order of the customer and closes its page', async () => {
      const first = await start();
      const second = await start();

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(orders.rows.get(first.value.orderId)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'superseded',
      });
      expect(orders.rows.get(second.value.orderId)?.status).toBe('pending-payment');
      expect(gateway.expired).toEqual(['cs_test_1']);
    });

    it('is for a signed-in customer only', async () => {
      expect(await start(anonymous)).toMatchObject({ ok: false });
      expect(inventory.calls).toEqual([]);
    });
  });

  describe('confirm-payment', () => {
    const started = async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      return orders.rows.get(result.value.orderId)!;
    };

    it('commits the stock, then captures, then confirms and clears the cart', async () => {
      const order = await started();
      const confirmed = await confirm(order.id);

      expect(confirmed).toEqual(ok('confirmed'));
      expect(inventory.calls).toEqual(['reserve', 'commit']);
      expect(inventory.committed[0]).toMatchObject({
        reservationId: order.reservationId,
        checkoutRef: order.id,
      });
      expect(
        (inventory.committed[0] as { lines: { orderLineId: string }[] }).lines.map(
          (l) => l.orderLineId,
        ),
      ).toEqual(order.lines.map((l) => l.id));
      expect(gateway.captured).toEqual([['pi_test_1', `capture-${order.id}`]]);
      expect(orders.rows.get(order.id)).toMatchObject({
        status: 'confirmed',
        paymentState: 'captured',
        stripePaymentIntentId: 'pi_test_1',
      });
      expect(cart.cleared).toEqual([
        {
          accountId: ACCOUNT,
          units: order.lines.map((l) => ({ offerId: l.offerId, variantId: l.variantId })),
        },
      ]);
    });

    it('writes one ordering.order-paid.v1 event with ids only, in the confirming unit', async () => {
      const order = await started();
      await confirm(order.id);

      expect(written).toHaveLength(1);
      const event = written[0]!;
      expect(event).toMatchObject({
        type: 'ordering.order-paid.v1',
        aggregateType: 'order',
        aggregateId: order.id,
      });
      expect(event.payload).toEqual({
        orderId: order.id,
        sellerOrderIds: order.sellerOrders.map((so) => so.id),
        sellerIds: order.sellerOrders.map((so) => so.sellerId),
      });
      // Ids only: nothing like an address, a name or an amount.
      expect(JSON.stringify(event.payload)).not.toMatch(/@|email|amount/i);
    });

    it('asks for a retry, not a throw, when the outbox refuses the event', async () => {
      const order = await started();
      deps = {
        ...deps,
        outbox: { append: () => Promise.reject(new OutboxWriteRefusedError('payload-invalid')) },
      };

      expect(await confirm(order.id)).toEqual(err({ code: 'ordering.try-again' }));
    });

    it('writes no event for a repeat, a voided payment or a retry', async () => {
      const order = await started();
      await confirm(order.id);
      await confirm(order.id);
      await confirm(order.id, undefined, 'pi_test_2');
      expect(written).toHaveLength(1);
    });

    it('captures only after the commit succeeded', async () => {
      const order = await started();
      inventory.commitFails = {
        code: 'inventory.insufficient',
        details: { lines: [{ offerId: OFFER_1, variantId: VARIANT, reason: 'out' }] },
      };
      const confirmed = await confirm(order.id);

      expect(confirmed).toEqual(ok('voided'));
      expect(gateway.captured).toEqual([]);
      expect(gateway.voided).toEqual([['pi_test_1', 'void-pi_test_1']]);
      expect(inventory.calls).toContain('release:cancelled');
      expect(orders.rows.get(order.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'stock-unavailable',
        paymentState: 'voided',
      });
      expect(cart.cleared).toEqual([]);
    });

    it('voids a payment whose amount differs from the order total', async () => {
      const order = await started();
      const confirmed = await confirm(order.id, order.total.amount - 1n);

      expect(confirmed).toEqual(ok('voided'));
      expect(gateway.captured).toEqual([]);
      expect(inventory.calls).not.toContain('commit');
      expect(orders.rows.get(order.id)?.status).toBe('cancelled');
    });

    it('voids a payment for an order that was cancelled meanwhile', async () => {
      const order = await started();
      await new CancelPayment(gate, deps).execute(system, { orderId: order.id, cause: 'expired' });
      const confirmed = await confirm(order.id);

      expect(confirmed).toEqual(ok('voided'));
      expect(gateway.captured).toEqual([]);
      expect(inventory.calls).not.toContain('commit');
      expect(orders.rows.get(order.id)).toMatchObject({
        status: 'cancelled',
        paymentState: 'voided',
        stripePaymentIntentId: 'pi_test_1',
      });
    });

    it('is idempotent: a repeated event changes nothing, a second payment is voided', async () => {
      const order = await started();
      await confirm(order.id);
      const repeat = await confirm(order.id);
      const second = await confirm(order.id, undefined, 'pi_test_2');

      expect(repeat).toEqual(ok('already-confirmed'));
      expect(second).toEqual(ok('voided'));
      expect(gateway.captured).toHaveLength(1);
      expect(gateway.voided).toEqual([['pi_test_2', 'void-pi_test_2']]);
      expect(inventory.calls.filter((c) => c === 'commit')).toHaveLength(1);
      expect(orders.rows.get(order.id)?.status).toBe('confirmed');
    });

    it('asks for a retry when the provider is down, and the retry finishes the job', async () => {
      const order = await started();
      gateway.captureFails = { code: 'payment.provider-unavailable' };
      const first = await confirm(order.id);
      expect(first).toEqual(err({ code: 'ordering.try-again' }));
      expect(orders.rows.get(order.id)).toMatchObject({
        status: 'pending-payment',
        paymentState: 'authorised',
      });

      gateway.captureFails = null;
      const retry = await confirm(order.id);
      expect(retry).toEqual(ok('confirmed'));
      expect(gateway.captured).toHaveLength(1);
    });

    it('gives the stock back when the capture is refused for good', async () => {
      const order = await started();
      gateway.captureFails = { code: 'payment.provider-rejected' };
      const confirmed = await confirm(order.id);

      expect(confirmed).toEqual(ok('voided'));
      expect(inventory.calls.filter((c) => c.startsWith('cancel-line:'))).toHaveLength(3);
      expect(orders.rows.get(order.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'payment-failed',
      });
    });

    it('retries a commit lock timeout and then asks for a retry', async () => {
      const order = await started();
      inventory.commitFails = { code: 'conflict.retry' };
      inventory.commitFailuresLeft = 10;
      expect(await confirm(order.id)).toEqual(err({ code: 'ordering.try-again' }));
      expect(inventory.calls.filter((c) => c === 'commit')).toHaveLength(3);
      expect(gateway.captured).toEqual([]);
      expect(orders.rows.get(order.id)?.status).toBe('pending-payment');
    });

    it('refuses a payment that carries another order’s Checkout session', async () => {
      const order = await started();
      const result = await new ConfirmPayment(gate, deps).execute(system, {
        orderId: order.id,
        paymentIntentId: 'pi_test_1',
        sessionId: 'cs_test_other',
        amount: order.total,
      });
      expect(result).toEqual(err({ code: 'validation.failed' }));
      expect(gateway.captured).toEqual([]);
      expect(inventory.calls).toEqual(['reserve']);
    });

    it('leaves an order with an authorised payment alone when a newer checkout supersedes it', async () => {
      const first = await start();
      if (!first.ok) throw new Error('checkout failed');
      const row = orders.rows.get(first.value.orderId)!;
      orders.rows.set(row.id, {
        ...row,
        paymentState: 'authorised',
        stripePaymentIntentId: 'pi_test_1',
      });

      await start();

      expect(orders.rows.get(first.value.orderId)).toMatchObject({
        status: 'pending-payment',
        paymentState: 'authorised',
      });
      expect(gateway.expired).toEqual([]);
    });

    it('does not cancel when the hold was committed meanwhile, and asks for a retry', async () => {
      const order = await started();
      inventory.releaseCommitted = true;
      const result = await new CancelPayment(gate, deps).execute(system, {
        orderId: order.id,
        cause: 'expired',
      });
      expect(result).toEqual(err({ code: 'ordering.try-again' }));
      expect(orders.rows.get(order.id)?.status).toBe('pending-payment');
    });

    it('answers an unknown order and a malformed id without touching anything', async () => {
      expect(await confirm(id<'Order'>(0xdead), 100n)).toEqual(
        err({ code: 'ordering.order-not-found' }),
      );
      expect(
        await new ConfirmPayment(gate, deps).execute(system, {
          orderId: 'nope',
          paymentIntentId: 'pi_test_1',
          sessionId: 'cs_test_1',
          amount: money(1n, currency),
        }),
      ).toEqual(err({ code: 'validation.failed' }));
      expect(gateway.captured).toEqual([]);
    });

    it('is for the system actor only', async () => {
      const order = await started();
      const denied = await new ConfirmPayment(gate, deps).execute(customer, {
        orderId: order.id,
        paymentIntentId: 'pi_test_1',
        sessionId: 'cs_test_1',
        amount: order.total,
      });
      expect(denied.ok).toBe(false);
      expect(gateway.captured).toEqual([]);
    });
  });

  describe('cancel-payment', () => {
    it('cancels a pending order and releases its hold; a settled order is left alone', async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      const cancel = new CancelPayment(gate, deps);

      expect(
        await cancel.execute(system, { orderId: result.value.orderId, cause: 'expired' }),
      ).toEqual(ok('cancelled'));
      expect(inventory.calls).toContain('release:cancelled');
      expect(orders.rows.get(result.value.orderId)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'expired',
      });
      expect(
        await cancel.execute(system, { orderId: result.value.orderId, cause: 'expired' }),
      ).toEqual(ok('ignored'));
    });

    it('voids an authorisation still on the card before it cancels', async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      gateway.captureFails = { code: 'payment.provider-unavailable' };
      await confirm(result.value.orderId); // authorised, capture pending

      const cancelled = await new CancelPayment(gate, deps).execute(system, {
        orderId: result.value.orderId,
        cause: 'payment-failed',
      });

      expect(cancelled).toEqual(ok('cancelled'));
      expect(gateway.voided).toEqual([['pi_test_1', 'void-pi_test_1']]);
      expect(orders.rows.get(result.value.orderId)).toMatchObject({
        status: 'cancelled',
        paymentState: 'voided',
      });
    });
  });

  describe('order reads', () => {
    it('shows a customer only their own orders, newest first, with a cursor', async () => {
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        clock.advance(Temporal.Duration.from({ seconds: 60 }));
        const result = await start();
        if (result.ok) ids.push(result.value.orderId);
      }
      const list = new ListOrders(gate, deps);

      const first = await list.execute(customer, { limit: 2 });
      expect(first.ok && first.value.orders.map((o) => o.orderId)).toEqual([ids[2], ids[1]]);
      const cursor = first.ok ? first.value.nextCursor : null;
      expect(cursor).not.toBeNull();
      const second = await list.execute(customer, { limit: 2, cursor });
      expect(second.ok && second.value.orders.map((o) => o.orderId)).toEqual([ids[0]]);
      expect(second.ok && second.value.nextCursor).toBeNull();

      const other = await list.execute(customerOf(OTHER), {});
      expect(other.ok && other.value.orders).toEqual([]);
      expect(await list.execute(customer, { limit: 0, cursor: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it("answers another customer's order exactly as an unknown one", async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      const view = new ViewOrder(gate, deps);

      const own = await view.execute(customer, { orderId: result.value.orderId });
      expect(own.ok && own.value.sellerOrders).toHaveLength(2);
      const foreign = await view.execute(customerOf(OTHER), { orderId: result.value.orderId });
      const unknown = await view.execute(customer, { orderId: id<'Order'>(0xbeef) });
      expect(foreign).toEqual(err({ code: 'ordering.order-not-found' }));
      expect(unknown).toEqual(foreign);
    });

    it('lets an admin read any order and filter by status', async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: id<'Account'>(0xad),
          sessionId: id<'Session'>(0x62),
          sellerId: null,
        }),
        'order-0004-abcd',
      );
      const view = await new AdminViewOrder(gate, deps).execute(admin, {
        orderId: result.value.orderId,
      });
      const pending = await new AdminListOrders(gate, deps).execute(admin, {
        status: 'pending-payment',
      });
      const confirmed = await new AdminListOrders(gate, deps).execute(admin, {
        status: 'confirmed',
      });
      const bad = await new AdminListOrders(gate, deps).execute(admin, { status: 'shipped' });

      expect(view.ok && view.value.accountId).toBe(ACCOUNT);
      expect(pending.ok && pending.value.orders).toHaveLength(1);
      expect(confirmed.ok && confirmed.value.orders).toEqual([]);
      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    const adminContext = () =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: id<'Account'>(0xad),
          sessionId: id<'Session'>(0x62),
          sellerId: null,
        }),
        'order-0005-abcd',
      );

    it('names the products, stores and customer, with one batched call per lookup', async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      labels.label({ offerId: OFFER_1, variantId: VARIANT }, 'Lamb mince', '500 g');
      labels.stores.set(SELLER_A, 'Corner Butcher');
      labels.customers.set(ACCOUNT, { displayName: null, email: 'jane@example.com' });

      const list = await new AdminListOrders(gate, deps).execute(adminContext(), {});
      const view = await new AdminViewOrder(gate, deps).execute(adminContext(), {
        orderId: result.value.orderId,
      });

      if (!list.ok || !view.ok) throw new Error('read failed');
      expect(list.value.orders[0]).toEqual(view.value);
      expect(view.value.customer).toEqual({ displayName: null, email: 'jane@example.com' });
      const a = view.value.sellerOrders.find((s) => s.sellerId === SELLER_A)!;
      const b = view.value.sellerOrders.find((s) => s.sellerId === SELLER_B)!;
      expect(a.storeName).toBe('Corner Butcher');
      expect(b.storeName).toBeNull();
      expect(a.lines.find((l) => l.offerId === OFFER_1)).toMatchObject({
        productName: 'Lamb mince',
        variantLabel: '500 g',
      });
      expect(a.lines.find((l) => l.offerId === OFFER_3)).toMatchObject({
        productName: null,
        variantLabel: null,
      });
      // Distinct keys: three units, two sellers, one customer; per read, never per order.
      expect(labels.calls.slice(0, 3)).toEqual([
        { lookup: 'units', count: 3 },
        { lookup: 'stores', count: 2 },
        { lookup: 'customers', count: 1 },
      ]);
    });

    it('still answers, with null names, when every lookup fails', async () => {
      const result = await start();
      if (!result.ok) throw new Error('checkout failed');
      labels.fail.add('units').add('stores').add('customers');

      const view = await new AdminViewOrder(gate, deps).execute(adminContext(), {
        orderId: result.value.orderId,
      });

      if (!view.ok) throw new Error('read failed');
      expect(view.value.customer).toBeNull();
      for (const seller of view.value.sellerOrders) {
        expect(seller.storeName).toBeNull();
        for (const line of seller.lines) {
          expect(line).toMatchObject({ productName: null, variantLabel: null });
        }
      }
    });

    it('looks nothing up for an empty page', async () => {
      const list = await new AdminListOrders(gate, deps).execute(adminContext(), {});

      expect(list).toEqual({ ok: true, value: { orders: [], nextCursor: null } });
      expect(labels.calls).toEqual([]);
    });
  });
  describe('flat delivery fee', () => {
    it('refuses the whole cart when a seller has no fee, naming no seller to the customer', async () => {
      shipping.fees.delete(SELLER_B);
      const result = await start();

      expect(result).toEqual(err({ code: 'ordering.shipping-unavailable', sellerIds: [SELLER_B] }));
      // Nothing is reserved, stored or sent to Stripe.
      expect(inventory.calls).toEqual([]);
      expect(orders.rows.size).toBe(0);
      expect(gateway.sessions).toEqual([]);
    });

    it('refuses a fee in another currency and a fee that cannot be read', async () => {
      shipping.fees.set(SELLER_A, money(500n, currency === 'AUD' ? 'JPY' : 'AUD'));
      expect(await start()).toMatchObject({
        ok: false,
        error: { code: 'ordering.shipping-unavailable', sellerIds: [SELLER_A] },
      });

      shipping.down = true;
      expect(await start()).toEqual(err({ code: 'ordering.check-unavailable' }));
      expect(orders.rows.size).toBe(0);
    });

    it('freezes the fee in the order: a later change does not touch it', async () => {
      const first = await start();
      if (!first.ok) throw new Error('checkout failed');
      shipping.fees.set(SELLER_A, money(9_900n, currency));

      const stored = orders.rows.get(first.value.orderId)!;
      expect(stored.sellerOrders[0]).toMatchObject({ shipping: 500n, total: 2599n });
    });

    it('confirms against the total with delivery, and voids a payment of the goods only', async () => {
      const order = await placed();
      expect(order.total.amount).toBe(2000n + 750n + 99n + 500n);

      const short = await confirm(order.id, 2000n + 750n + 99n);
      expect(short).toEqual(ok('voided'));
      expect(gateway.captured).toEqual([]);
    });
  });

  describe('seller fulfilment', () => {
    const sellerOf = (sellerId: Id<'Seller'>, n = 0x71) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: id<'Account'>(n),
          sessionId: id<'Session'>(n + 0x100),
          sellerId,
        }),
        `order-seller-${n}`,
      );
    const sellerA = sellerOf(SELLER_A);
    const sellerB = sellerOf(SELLER_B, 0x72);
    const list = (context: CallContext, input = {}) =>
      new SellerListOrders(gate, deps).execute(context, input);
    const ship = (context: CallContext, sellerOrderId: string, input = {}) =>
      new SellerShipOrder(gate, deps).execute(context, {
        sellerOrderId,
        carrier: 'Australia Post',
        trackingRef: 'AP123456789',
        ...input,
      });
    const deliver = (context: CallContext, sellerOrderId: string) =>
      new SellerDeliverOrder(gate, deps).execute(context, { sellerOrderId });
    const sellerOrderIdOf = (orderId: string, sellerId: Id<'Seller'>) =>
      orders.rows.get(orderId)!.sellerOrders.find((s) => s.sellerId === sellerId)!.id;

    /** A paid order of both sellers. */
    const paid = async () => {
      const order = await placed();
      const confirmed = await confirm(order.id);
      expect(confirmed).toEqual(ok('confirmed'));
      return order;
    };

    it('shows a seller only its own paid orders, and nothing before payment', async () => {
      const order = await placed();
      const before = await list(sellerA);
      expect(before.ok && before.value.sellerOrders).toEqual([]);

      await confirm(order.id);
      const a = await list(sellerA);
      const b = await list(sellerB);

      expect(a.ok && a.value.sellerOrders).toHaveLength(1);
      expect(a.ok && a.value.sellerOrders[0]).toMatchObject({
        orderId: order.id,
        sellerId: SELLER_A,
        fulfilment: 'to-ship',
        shipping: money(500n, currency),
        total: money(2599n, currency),
      });
      expect(a.ok && a.value.sellerOrders[0]!.lines).toHaveLength(2);
      expect(b.ok && b.value.sellerOrders[0]).toMatchObject({
        sellerId: SELLER_B,
        shipping: money(0n, currency),
      });
    });

    it('pages by payment time with an opaque cursor and refuses a malformed one', async () => {
      await paid();
      const page = await list(sellerA, { limit: 1 });
      expect(page.ok && page.value.nextCursor).toBeNull();

      expect(await list(sellerA, { cursor: 'nope' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'cursor', code: 'format' }] },
      });
      expect(await list(sellerA, { limit: 0 })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('writes one order-shipped event with ids only, and none for a refused shipment', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);
      written.length = 0;

      expect(await ship(sellerB, sellerOrderId)).toEqual(
        err({ code: 'ordering.seller-order-not-found' }),
      );
      expect(await ship(sellerA, sellerOrderId, { carrier: '' })).toMatchObject({ ok: false });
      expect(written).toEqual([]);

      await ship(sellerA, sellerOrderId);
      await ship(sellerA, sellerOrderId);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ type: 'ordering.order-shipped.v1' });
      expect(written[0]!.payload).toEqual({
        orderId: order.id,
        sellerOrderId,
        sellerId: SELLER_A,
      });
      expect(JSON.stringify(written[0]!.payload)).not.toMatch(/AP123456789|Australia Post|@/);
    });

    it('rolls the shipment back as a conflict when the outbox refuses the event', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);
      deps = {
        ...deps,
        outbox: { append: () => Promise.reject(new OutboxWriteRefusedError('payload-invalid')) },
      };
      // The unit rolls back with the refusal (the real unit commits nothing on err).
      const before = new Map(orders.rows);
      deps = {
        ...deps,
        unitOfWork: {
          run: async (market, work, options) => {
            const result = await new FakeUnitOfWork().run(market, work, options);
            if (!result.ok) {
              orders.rows.clear();
              for (const [key, row] of before) orders.rows.set(key, row);
            }
            return result;
          },
        } as OrderingDependencies['unitOfWork'],
      };
      expect(await ship(sellerA, sellerOrderId)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      const stored = orders.rows.get(order.id)!.sellerOrders.find((s) => s.id === sellerOrderId)!;
      expect(stored.fulfilment).toBe('to-ship');
      expect(stored.carrier).toBeNull();
    });

    describe('shipment-notice', () => {
      const notice = (context: CallContext, input: unknown) =>
        new ShipmentNoticeQuery(gate, deps).execute(context, input as never);
      const other = code === 'AU' ? 'ZZ' : 'AU';

      it('is for the system actor only and reads nothing for anyone else', async () => {
        const order = await paid();
        const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);
        await ship(sellerA, sellerOrderId);
        let reads = 0;
        const findById = orders.findById.bind(orders);
        orders.findById = (...args) => {
          reads += 1;
          return findById(...args);
        };
        for (const context of [sellerA, customer, anonymous]) {
          expect(await notice(context, { orderId: order.id, sellerOrderId })).toEqual(
            err({ code: 'access.denied' }),
          );
        }
        expect(reads).toBe(0);
      });

      it('answers the carrier and tracking number, and exactly that', async () => {
        const order = await paid();
        const a = sellerOrderIdOf(order.id, SELLER_A);
        const b = sellerOrderIdOf(order.id, SELLER_B);
        await ship(sellerA, a);
        await ship(sellerB, b, { trackingRef: undefined });

        expect(await notice(system, { orderId: order.id, sellerOrderId: a })).toEqual(
          ok({
            orderId: order.id,
            accountId: order.accountId,
            sellerOrderId: a,
            carrier: 'Australia Post',
            trackingRef: 'AP123456789',
          }),
        );
        expect(await notice(system, { orderId: order.id, sellerOrderId: b })).toEqual(
          ok({
            orderId: order.id,
            accountId: order.accountId,
            sellerOrderId: b,
            carrier: 'Australia Post',
            trackingRef: null,
          }),
        );
      });

      it('answers not-found for an unknown, foreign, unshipped or unpaid seller order', async () => {
        const order = await paid();
        const a = sellerOrderIdOf(order.id, SELLER_A);
        const notFound = err({ code: 'ordering.order-not-found' });

        // Still to-ship.
        expect(await notice(system, { orderId: order.id, sellerOrderId: a })).toEqual(notFound);
        await ship(sellerA, a);
        // Unknown seller order id.
        expect(
          await notice(system, { orderId: order.id, sellerOrderId: id<'SellerOrder'>(0xdead) }),
        ).toEqual(notFound);
        // A seller order of another order.
        const second = await placed();
        expect(await notice(system, { orderId: second.id, sellerOrderId: a })).toEqual(notFound);
        // An order that is not confirmed.
        expect(
          await notice(system, {
            orderId: second.id,
            sellerOrderId: sellerOrderIdOf(second.id, SELLER_A),
          }),
        ).toEqual(notFound);
      });

      it('answers not-found for an order of the other Market', async () => {
        const order = await paid();
        const a = sellerOrderIdOf(order.id, SELLER_A);
        await ship(sellerA, a);
        const otherSystem = testCallContext(
          testMarketContext(other, 'default'),
          'system',
          'order-0009-abcd',
        );
        // The store is keyed by Market: an order of this Market is invisible from the other.
        const own = orders.findById.bind(orders);
        orders.findById = (m, orderId) =>
          m.marketId === market.marketId ? own(m, orderId) : Promise.resolve(null);

        expect(await notice(otherSystem, { orderId: order.id, sellerOrderId: a })).toEqual(
          err({ code: 'ordering.order-not-found' }),
        );
      });

      it('refuses an invalid order id', async () => {
        for (const orderId of ['nope', 42, undefined]) {
          expect(await notice(system, { orderId, sellerOrderId: id<'SellerOrder'>(1) })).toEqual(
            err({ code: 'validation.failed' }),
          );
        }
      });
    });

    it('refuses a carrier or tracking reference that reads as a link', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_B);
      for (const carrier of ['track.evil-example.com/login', 'evil.com', 'a/b']) {
        expect(await ship(sellerB, sellerOrderId, { carrier })).toMatchObject({
          ok: false,
          error: { fields: [{ path: 'carrier', code: 'format' }] },
        });
      }
      for (const trackingRef of [
        'track.evil-example.com/login',
        'AP1/2',
        'evil.com',
        'track.evil-example.com',
      ]) {
        expect(await ship(sellerB, sellerOrderId, { trackingRef })).toMatchObject({
          ok: false,
          error: { fields: [{ path: 'trackingRef', code: 'format' }] },
        });
      }
      expect(await ship(sellerB, sellerOrderId, { carrier: 'Aus. Post' })).toMatchObject({
        ok: true,
      });
    });

    it('ships once, then delivers once, in that order', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);

      const early = await deliver(sellerA, sellerOrderId);
      expect(early).toEqual(err({ code: 'ordering.fulfilment-conflict' }));

      const shipped = await ship(sellerA, sellerOrderId);
      expect(shipped.ok && shipped.value).toMatchObject({
        fulfilment: 'shipped',
        carrier: 'Australia Post',
        trackingRef: 'AP123456789',
        shippedAt: T0,
        deliveredAt: null,
      });
      expect(await ship(sellerA, sellerOrderId)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );

      const delivered = await deliver(sellerA, sellerOrderId);
      expect(delivered.ok && delivered.value).toMatchObject({
        fulfilment: 'delivered',
        deliveredAt: T0,
      });
      expect(await deliver(sellerA, sellerOrderId)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      // The customer sees the same on the order, without any change to the other seller's part.
      const customerView = await new ViewOrder(gate, deps).execute(customer, {
        orderId: order.id,
      });
      expect(customerView.ok && customerView.value.sellerOrders.map((s) => s.fulfilment)).toEqual([
        'delivered',
        'to-ship',
      ]);
    });

    it('takes no tracking reference, and refuses markup or an empty carrier', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_B);

      for (const carrier of ['', '<b>Post</b>', 'x'.repeat(61), 42, undefined]) {
        expect(await ship(sellerB, sellerOrderId, { carrier })).toMatchObject({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'carrier', code: 'format' }] },
        });
      }
      expect(
        await ship(sellerB, sellerOrderId, { trackingRef: 'https://evil.test/?x=1' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'trackingRef', code: 'format' }] },
      });

      const shipped = await ship(sellerB, sellerOrderId, { trackingRef: undefined });
      expect(shipped.ok && shipped.value).toMatchObject({
        fulfilment: 'shipped',
        trackingRef: null,
      });
    });

    it("answers another shop's order exactly as an unknown id, and an unpaid one too", async () => {
      const unpaid = await placed();
      const unpaidId = sellerOrderIdOf(unpaid.id, SELLER_A);
      expect(await ship(sellerA, unpaidId)).toEqual(
        err({ code: 'ordering.seller-order-not-found' }),
      );

      await confirm(unpaid.id);
      expect(await ship(sellerB, unpaidId)).toEqual(
        err({ code: 'ordering.seller-order-not-found' }),
      );
      expect(await deliver(sellerB, unpaidId)).toEqual(
        err({ code: 'ordering.seller-order-not-found' }),
      );
      const view = new SellerViewOrder(gate, deps);
      expect(await view.execute(sellerB, { sellerOrderId: unpaidId })).toEqual(
        err({ code: 'ordering.seller-order-not-found' }),
      );
      expect(await view.execute(sellerB, { sellerOrderId: 'not-an-id' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      // Nothing changed for the owner.
      expect(orders.rows.get(unpaid.id)!.sellerOrders[0]!.fulfilment).toBe('to-ship');
    });

    it('refuses a customer, an anonymous caller and the system on the seller routes', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);
      for (const context of [customer, anonymous, system]) {
        expect((await list(context)).ok).toBe(false);
        expect((await ship(context, sellerOrderId)).ok).toBe(false);
        expect((await deliver(context, sellerOrderId)).ok).toBe(false);
      }
      expect(orders.rows.get(order.id)!.sellerOrders[0]!.fulfilment).toBe('to-ship');
    });

    it('tells inventory about a shipment through the worker, once, and retries a refusal', async () => {
      const order = await paid();
      const sellerOrderId = sellerOrderIdOf(order.id, SELLER_A);
      const record = () => new RecordShipments(gate, deps).execute(system, {});

      // Nothing shipped, nothing to record.
      expect(await record()).toEqual(ok({ recorded: 0, failed: [] }));
      expect(inventory.shipped).toEqual([]);

      await ship(sellerA, sellerOrderId);
      inventory.shipmentFails = { code: 'conflict.retry' };
      const failed = await record();
      expect(failed).toEqual(
        ok({ recorded: 0, failed: [{ sellerOrderId, code: 'conflict.retry' }] }),
      );

      inventory.shipmentFails = null;
      const done = await record();
      expect(done).toEqual(ok({ recorded: 1, failed: [] }));
      const lineIds = orders.rows
        .get(order.id)!
        .lines.filter((l) => l.sellerOrderId === sellerOrderId)
        .map((l) => l.id);
      expect(inventory.shipped).toEqual(lineIds);

      // The seller order is marked, so the next run finds nothing.
      expect(await record()).toEqual(ok({ recorded: 0, failed: [] }));
      expect(inventory.shipped).toEqual(lineIds);
      // Only the system actor may run it.
      expect(await new RecordShipments(gate, deps).execute(customer, {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('commission and the seller ledger', () => {
    it("freezes each seller's rate on its lines at placement; a later change does not touch them", async () => {
      commission.rates.set(SELLER_A, 1000);
      const order = await placed();
      const rateOf = (sellerId: Id<'Seller'>) => {
        const sellerOrder = order.sellerOrders.find((s) => s.sellerId === sellerId)!;
        return order.lines
          .filter((l) => l.sellerOrderId === sellerOrder.id)
          .map((l) => l.commissionRateBps);
      };
      expect(rateOf(SELLER_A)).toEqual([1000, 1000]);
      expect(rateOf(SELLER_B)).toEqual([1500]);
      expect(order.sellerOrders.map((s) => s.ledgerState)).toEqual(['pending', 'pending']);

      commission.rates.set(SELLER_A, 2500);
      commission.marketRateBps = 500;
      expect(
        orders.rows
          .get(order.id)!
          .lines.map((l) => l.commissionRateBps)
          .sort(),
      ).toEqual([1000, 1000, 1500]);
    });

    it('opens no order when the rates cannot be read (fail closed)', async () => {
      commission.down = true;
      expect(await start()).toEqual(err({ code: 'ordering.check-unavailable' }));
      expect(orders.rows.size).toBe(0);
      expect(inventory.reserved).toEqual([]);
      expect(gateway.sessions).toEqual([]);
    });

    it('sends each paid seller order to the ledger through the worker, once, and retries a refusal', async () => {
      const record = () => new RecordLedger(gate, deps).execute(system, {});
      const order = await placed();

      // Not paid yet: nothing goes to the ledger.
      expect(await record()).toEqual(ok({ recorded: 0, failed: [], stuck: [] }));
      expect(await confirm(order.id)).toEqual(ok('confirmed'));

      commission.recordFails = { code: 'commission-payouts.rate-unavailable' };
      expect(await record()).toMatchObject({ ok: true, value: { recorded: 0 } });
      commission.recordFails = null;
      expect(await record()).toEqual(ok({ recorded: 2, failed: [], stuck: [] }));

      const stored = orders.rows.get(order.id)!;
      expect(stored.sellerOrders.map((s) => s.ledgerState)).toEqual(['recorded', 'recorded']);
      const sellerA = stored.sellerOrders.find((s) => s.sellerId === SELLER_A)!;
      const sent = commission.recorded.find((r) => r.sellerOrderId === sellerA.id)!;
      expect(sent).toMatchObject({
        orderId: order.id,
        sellerId: SELLER_A,
        currency,
        shipping: 500n,
      });
      expect(sent.paidAt.equals(stored.confirmedAt!)).toBe(true);
      expect(sent.lines.map((l) => [l.lineAmount, l.taxInclusive, l.commissionRateBps])).toEqual(
        stored.lines
          .filter((l) => l.sellerOrderId === sellerA.id)
          .map((l) => [l.lineAmount, l.taxInclusive, 1500]),
      );

      // Marked, so the next run finds nothing; only the system actor may run it.
      expect(await record()).toEqual(ok({ recorded: 0, failed: [], stuck: [] }));
      expect(commission.recorded).toHaveLength(2);
      expect(await new RecordLedger(gate, deps).execute(customer, {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('refuses a seller order whose lines carry no frozen rate', async () => {
      const order = await placed();
      expect(await confirm(order.id)).toEqual(ok('confirmed'));
      const stored = orders.rows.get(order.id)!;
      orders.rows.set(order.id, {
        ...stored,
        lines: stored.lines.map((l) => ({ ...l, commissionRateBps: null })),
      });
      const result = await new RecordLedger(gate, deps).execute(system, {});
      expect(result).toMatchObject({ ok: true, value: { recorded: 0 } });
      expect(result.ok && result.value.failed.map((f) => f.code)).toEqual([
        'ordering.rate-not-frozen',
        'ordering.rate-not-frozen',
      ]);
      expect(commission.recorded).toEqual([]);
      // Each refusal is counted, so the queue takes other seller orders first.
      expect([...orders.ledgerFailures.values()]).toEqual([1, 1]);
    });

    it('reports a seller order as stuck once, when its refusals reach 5', async () => {
      const order = await placed();
      expect(await confirm(order.id)).toEqual(ok('confirmed'));
      commission.recordFails = { code: 'commission-payouts.rate-unavailable' };
      const run = () => new RecordLedger(gate, deps).execute(system, {});
      const stuckPerRun: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await run();
        stuckPerRun.push(result.ok ? result.value.stuck.length : -1);
        if (i === 4 && result.ok) {
          expect(result.value.stuck.map((entry) => [entry.attempts, entry.code])).toEqual([
            [5, 'commission-payouts.rate-unavailable'],
            [5, 'commission-payouts.rate-unavailable'],
          ]);
        }
      }
      expect(stuckPerRun).toEqual([0, 0, 0, 0, 2, 0]);
    });
  });
});
