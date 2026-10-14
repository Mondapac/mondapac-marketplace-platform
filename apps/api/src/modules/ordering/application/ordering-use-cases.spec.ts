import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
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
  MemoryOrders,
} from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
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
import { StartCheckout } from './use-cases/start-checkout.use-case';
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
  let deps: OrderingDependencies;

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
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  const start = (context: CallContext = customer) =>
    new StartCheckout(gate, deps).execute(context, {});
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
      expect(started.value.total).toEqual(money(2000n + 750n + 99n, currency));
      expect(started.value.payBy.epochMilliseconds).toBe(T0.add({ minutes: 30 }).epochMilliseconds);

      const order = orders.rows.get(started.value.orderId)!;
      expect(order).toMatchObject({
        status: 'pending-payment',
        paymentState: 'none',
        accountId: ACCOUNT,
        stripeSessionId: 'cs_test_1',
        stripeIdempotencyKey: `checkout-${order.id}`,
      });
      // Two sellers, each with its own subtotal; shipping is 0 until SHP-01.
      expect(order.sellerOrders.map((s) => [s.sellerId, s.subtotal, s.shipping, s.total])).toEqual([
        [SELLER_A, 2099n, 0n, 2099n],
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
      expect(session.packages.map((p) => p.amount)).toEqual([2099n, 750n]);
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
  });
});
