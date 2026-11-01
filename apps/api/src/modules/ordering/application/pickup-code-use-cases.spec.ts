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
  FakeCommission,
  FakeCustomers,
  FakeGateway,
  FakeInventory,
  FakeLabels,
  FakeAttemptLimits,
  FakePickupVault,
  AllowAllDeliveryMethods,
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
import { ConfigOrderingPolicy } from '../infrastructure/config-ordering-policy';
import { PICKUP_MAX_FAILED_ATTEMPTS } from '../domain/pickup-code';
import type { OrderingDependencies } from './checkout-flow';
import { ConfirmPayment } from './use-cases/confirm-payment.use-case';
import { RecordShipments } from './use-cases/record-shipments.use-case';
import { RegeneratePickupCode } from './use-cases/regenerate-pickup-code.use-case';
import { SellerConfirmPickup } from './use-cases/seller-confirm-pickup.use-case';
import { SellerListOrders } from './use-cases/seller-list-orders.use-case';
import { SellerMarkOrderReady } from './use-cases/seller-mark-order-ready.use-case';
import { SellerViewOrder } from './use-cases/seller-view-order.use-case';
import { StartCheckout } from './use-cases/start-checkout.use-case';
import { ViewOrder } from './use-cases/view-order.use-case';
import { ListOrders } from './use-cases/list-orders.use-case';

// In-person pickup on both Market fixtures (AU in AUD, ZZ in JPY): offered only with an approved
// pickup address and free; the code is made when the seller says ready and read by the buyer
// only; the seller's handover compares it, counts wrong tries, locks at five, and is idempotent.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa1);
const OTHER = id<'Account'>(0xa2);
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const ADDRESS = id<'CustomerAddress'>(0xad);
/** JSON.stringify for results that carry money in bigint minor units. */
const bigint = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

describe.each([['AU'], ['ZZ']] as const)('pickup code in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  let allowed = true;
  const gate = createUseCaseGate(markets, {
    check: () =>
      Promise.resolve(
        allowed
          ? { allowed: true }
          : ({ allowed: false, denial: { code: 'access.denied' } } as const),
      ),
  });
  const customerOf = (accountId: Id<'Account'>, n = 0x61) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(n),
        sellerId: null,
      }),
      `pickup-customer-${n}`,
    );
  const sellerOf = (sellerId: Id<'Seller'>, n = 0x71) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(n),
        sessionId: id<'Session'>(n + 0x100),
        sellerId,
      }),
      `pickup-seller-${n}`,
    );
  const customer = customerOf(ACCOUNT);
  const system = testCallContext(market, 'system', 'pickup-system-0001');
  const sellerA = sellerOf(SELLER_A);
  const sellerB = sellerOf(SELLER_B, 0x72);

  let orders: MemoryOrders;
  let codes: MemoryPickupCodes;
  let vault: FakePickupVault;
  let shipping: FakeShipping;
  let cart: FakeCart;
  let inventory: FakeInventory;
  let deps: OrderingDependencies;
  let written: PendingEvent[];

  const line = (offerId: number, sellerId: Id<'Seller'>, unit: bigint): CheckoutLine => ({
    offerId: id<'Offer'>(offerId),
    variantId: id<'Variant'>(0x10),
    quantity: 1,
    state: 'buyable',
    sellerId,
    unitPrice: money(unit, currency),
    taxInclusive: true,
  });

  beforeEach(() => {
    allowed = true;
    orders = new MemoryOrders();
    codes = new MemoryPickupCodes();
    vault = new FakePickupVault();
    shipping = new FakeShipping();
    cart = new FakeCart();
    inventory = new FakeInventory();
    written = [];
    const customers = new FakeCustomers();
    customers.addresses.set(ADDRESS, { accountId: ACCOUNT, address: TEST_DELIVERY_ADDRESS });
    shipping.quotedTotals.set(SELLER_A, money(500n, currency));
    shipping.quotedTotals.set(SELLER_B, money(500n, currency));
    shipping.pickupApproved = new Set([SELLER_A]);
    cart.lines = [line(1, SELLER_A, 1000n), line(2, SELLER_B, 250n)];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      orders,
      refunds: NO_REFUNDS,
      audit: NO_AUDIT,
      gateway: new FakeGateway(),
      policy: new ConfigOrderingPolicy(markets),
      cart,
      customers,
      shipTo: new FakeShipToCipher(),
      inventory,
      shipping,
      commission: new FakeCommission(),
      tax: new FakeTax(),
      taxCategories: new FakeTaxCategories(code === 'AU' ? 'taxable' : 'zz_standard'),
      outbox: {
        append: (_context, events) => {
          written.push(...events);
          return Promise.resolve();
        },
      },
      ids: new SequenceIdGenerator(clock),
      clock,
      labels: new FakeLabels(),
      deliveryMethods: new AllowAllDeliveryMethods(),
      pickupCodes: codes,
      pickupVault: vault,
      attempts: new FakeAttemptLimits(),
    };
  });

  const start = (deliveryMethods: unknown) =>
    new StartCheckout(gate, deps).execute(customer, { addressId: ADDRESS, deliveryMethods });
  /** A paid order: seller A pickup, seller B instant. */
  const paid = async (deliveryMethods: unknown = { [SELLER_A]: { method: 'pickup' } }) => {
    const started = await start(deliveryMethods);
    if (!started.ok) throw new Error(`checkout failed: ${started.error.code}`);
    const order = orders.rows.get(started.value.orderId)!;
    const confirmed = await new ConfirmPayment(gate, deps).execute(system, {
      orderId: order.id,
      paymentIntentId: 'pi_test_1',
      sessionId: 'cs_test_1',
      amount: order.total,
    });
    if (!confirmed.ok) throw new Error('payment failed');
    const stored = orders.rows.get(order.id)!;
    return { order: stored, pickup: stored.sellerOrders.find((s) => s.sellerId === SELLER_A)! };
  };
  const ready = (context: CallContext, sellerOrderId: string) =>
    new SellerMarkOrderReady(gate, deps).execute(context, { sellerOrderId });
  const confirmPickup = (context: CallContext, sellerOrderId: string, typed: unknown) =>
    new SellerConfirmPickup(gate, deps).execute(context, { sellerOrderId, code: typed });
  const viewOwn = (orderId: string, context: CallContext = customer) =>
    new ViewOrder(gate, deps).execute(context, { orderId });
  const regenerate = (orderId: string, sellerId: string, context: CallContext = customer) =>
    new RegeneratePickupCode(gate, deps).execute(context, { orderId, sellerId });
  /** A paid pickup order that the seller has marked ready; its code is 0427. */
  const readyOrder = async () => {
    vault.next = ['0427'];
    const placed = await paid();
    const said = await ready(sellerA, placed.pickup.id);
    if (!said.ok) throw new Error('ready failed');
    return placed;
  };
  const wrong = (typed = '1111') => typed;

  describe('at checkout', () => {
    it('offers pickup for a seller with an approved pickup address, free of any fee', async () => {
      const { order, pickup } = await paid();

      expect(pickup).toMatchObject({ deliveryMethod: 'pickup', shipping: 0n, total: 1000n });
      // The other seller delivers and pays its quoted delivery; a pickup was never quoted.
      expect(order.sellerOrders.find((s) => s.sellerId === SELLER_B)!.shipping).toBe(500n);
      expect(order.total.amount).toBe(1000n + 250n + 500n);
      expect(shipping.pickupAsked).toEqual([[SELLER_A]]);
      expect(shipping.chargeRequests.map((r) => r.sellerId)).toEqual([SELLER_B]);
      expect(shipping.chargeRequests[0]!.dropoff).toEqual({
        postcode: TEST_DELIVERY_ADDRESS.postcode,
        locality: TEST_DELIVERY_ADDRESS.suburb,
        region: TEST_DELIVERY_ADDRESS.region,
      });
    });

    it('needs no quote for a pickup seller and asks no quote when everything is pickup', async () => {
      shipping.pickupApproved = new Set([SELLER_A, SELLER_B]);
      shipping.quotedTotals.clear();

      const { order } = await paid({
        [SELLER_A]: { method: 'pickup' },
        [SELLER_B]: { method: 'pickup' },
      });

      expect(order.total.amount).toBe(1250n);
      expect(order.sellerOrders.map((s) => s.shipping)).toEqual([0n, 0n]);
      expect(shipping.chargeRequests).toEqual([]);
    });

    it('refuses pickup with a coded 422 for a seller without an approved pickup address', async () => {
      shipping.pickupApproved = new Set();

      const refused = await start({ [SELLER_A]: { method: 'pickup' } });

      expect(refused).toEqual(
        err({ code: 'ordering.pickup-unavailable', methodSellerIds: [SELLER_A] }),
      );
      expect(orders.rows.size).toBe(0);
      expect(inventory.calls).toEqual([]);
    });

    it('fails closed when the pickup address cannot be read', async () => {
      shipping.pickupDown = true;

      expect(await start({ [SELLER_A]: { method: 'pickup' } })).toEqual(
        err({ code: 'ordering.check-unavailable' }),
      );
      expect(orders.rows.size).toBe(0);
    });

    it('does not ask about pickup when nobody chose it', async () => {
      await start({ [SELLER_A]: { method: 'instant' } });
      expect(shipping.pickupAsked).toEqual([]);
    });
  });

  describe('issuing the code', () => {
    it('makes the code when the seller says ready, not when the order is paid', async () => {
      vault.next = ['0427'];
      const { pickup } = await paid();
      expect(codes.rows.size).toBe(0);
      expect(vault.issued).toEqual([]);

      const said = await ready(sellerA, pickup.id);

      expect(said.ok && said.value.pickup).toEqual({ attemptsLeft: 5, locked: false });
      expect(codes.rows.size).toBe(1);
      expect(codes.rows.get(pickup.id)).toMatchObject({
        failedAttempts: 0,
        lockedAt: null,
        issuedAt: T0,
      });
    });

    it('stores the hash and the sealed copy, never the code, and never lets the seller see it', async () => {
      const { pickup } = await readyOrder();

      const stored = codes.rows.get(pickup.id)!;
      expect(JSON.stringify(stored)).toContain('hash:');
      const seller = await new SellerViewOrder(gate, deps).execute(sellerA, {
        sellerOrderId: pickup.id,
      });
      const list = await new SellerListOrders(gate, deps).execute(sellerA, {});
      expect(JSON.stringify(seller, bigint)).not.toContain('0427');
      expect(JSON.stringify(list, bigint)).not.toContain('0427');
      expect(seller.ok && seller.value.pickup).toEqual({ attemptsLeft: 5, locked: false });
      // No event carries it either.
      expect(JSON.stringify(written, bigint)).not.toContain('0427');
    });

    it('makes a code once: a repeat of ready changes nothing', async () => {
      const { pickup } = await readyOrder();
      const before = codes.rows.get(pickup.id);

      const again = await ready(sellerA, pickup.id);

      expect(again.ok).toBe(true);
      expect(codes.rows.get(pickup.id)).toBe(before);
      expect(vault.issued).toEqual(['0427']);
      expect(written.filter((e) => e.type === 'ordering.seller-order-ready.v1')).toHaveLength(1);
    });

    it('makes no code for an order that is not a pickup', async () => {
      const { order } = await paid();
      const other = order.sellerOrders.find((s) => s.sellerId === SELLER_B)!;

      const said = await ready(sellerB, other.id);

      expect(said.ok && said.value.pickup).toBeNull();
      expect(codes.rows.size).toBe(0);
    });

    it('refuses ready for a pickup whose buyer account was erased, saving nothing', async () => {
      const { pickup } = await paid();
      vault.destroyed.add(ACCOUNT);

      expect(await ready(sellerA, pickup.id)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      expect(orders.rows.get([...orders.rows.keys()][0]!)!.sellerOrders[0]!.readyAt).toBeNull();
    });
  });

  describe('the buyer sees the code', () => {
    it('shows the code of a ready pickup part to the buyer who placed the order', async () => {
      const { order, pickup } = await readyOrder();

      const view = await viewOwn(order.id);

      expect(view.ok && view.value.pickupCodes).toEqual([
        { sellerId: SELLER_A, code: '0427', attemptsLeft: 5, locked: false },
      ]);
      expect(codes.rows.has(pickup.id)).toBe(true);
    });

    it('shows no code before ready, after the handover, nor to another customer', async () => {
      vault.next = ['0427'];
      const { order, pickup } = await paid();
      const before = await viewOwn(order.id);
      expect(before.ok && before.value.pickupCodes).toEqual([]);

      await ready(sellerA, pickup.id);
      const stranger = await viewOwn(order.id, customerOf(OTHER, 0x62));
      expect(stranger).toEqual(err({ code: 'ordering.order-not-found' }));

      expect((await confirmPickup(sellerA, pickup.id, '0427')).ok).toBe(true);
      const after = await viewOwn(order.id);
      expect(after.ok && after.value.pickupCodes).toEqual([]);
    });

    it('never puts the code in the list of orders', async () => {
      await readyOrder();

      const listed = await new ListOrders(gate, deps).execute(customer, {});

      expect(JSON.stringify(listed, bigint)).not.toContain('0427');
    });

    it('leaves the code out, and the order readable, when the account key is gone', async () => {
      const { order } = await readyOrder();
      vault.destroyed.add(ACCOUNT);

      const view = await viewOwn(order.id);

      expect(view.ok && view.value.pickupCodes).toEqual([]);
    });
  });

  describe('confirm pickup', () => {
    it('records a ready pickup order as collected with the right code', async () => {
      const { order, pickup } = await readyOrder();
      const later = T0.add({ minutes: 20 });
      clock.set(later);

      const done = await confirmPickup(sellerA, pickup.id, '0427');

      clock.set(T0);
      expect(done.ok && done.value).toMatchObject({
        fulfilment: 'delivered',
        carrier: null,
        trackingRef: null,
        pickup: null,
      });
      expect(orders.rows.get(order.id)!.sellerOrders.find((s) => s.id === pickup.id)).toMatchObject(
        { fulfilment: 'delivered', shippedAt: later, deliveredAt: later, carrier: null },
      );
      // The existing worker step tells inventory the lines left, as for any delivered order.
      const recorded = await new RecordShipments(gate, deps).execute(system, {});
      expect(recorded.ok && recorded.value.recorded).toBe(1);
      expect(inventory.shipped).toHaveLength(1);
    });

    it('is idempotent: a repeat on a collected order answers its state, even with another code', async () => {
      const { pickup } = await readyOrder();
      expect((await confirmPickup(sellerA, pickup.id, '0427')).ok).toBe(true);

      const again = await confirmPickup(sellerA, pickup.id, '0427');
      const other = await confirmPickup(sellerA, pickup.id, '9999');

      expect(again.ok && again.value.fulfilment).toBe('delivered');
      expect(other.ok && other.value.fulfilment).toBe('delivered');
      expect(codes.rows.get(pickup.id)!.failedAttempts).toBe(0);
    });

    it('refuses a wrong code, says how many tries are left, and changes nothing', async () => {
      const { order, pickup } = await readyOrder();

      const first = await confirmPickup(sellerA, pickup.id, wrong());
      const second = await confirmPickup(sellerA, pickup.id, wrong('2222'));

      expect(first).toEqual(err({ code: 'ordering.pickup-code-invalid', attemptsLeft: 4 }));
      expect(second).toEqual(err({ code: 'ordering.pickup-code-invalid', attemptsLeft: 3 }));
      expect(orders.rows.get(order.id)!.sellerOrders.find((s) => s.id === pickup.id)).toMatchObject(
        { fulfilment: 'to-ship' },
      );
      const seller = await new SellerViewOrder(gate, deps).execute(sellerA, {
        sellerOrderId: pickup.id,
      });
      expect(seller.ok && seller.value.pickup).toEqual({ attemptsLeft: 3, locked: false });
      // The right code still works while tries remain.
      expect((await confirmPickup(sellerA, pickup.id, '0427')).ok).toBe(true);
    });

    it('locks the order at the fifth wrong code, even for the right code, until the buyer renews it', async () => {
      const { order, pickup } = await readyOrder();
      for (let n = 1; n < PICKUP_MAX_FAILED_ATTEMPTS; n += 1) {
        expect(await confirmPickup(sellerA, pickup.id, '1111')).toEqual(
          err({
            code: 'ordering.pickup-code-invalid',
            attemptsLeft: PICKUP_MAX_FAILED_ATTEMPTS - n,
          }),
        );
      }

      const fifth = await confirmPickup(sellerA, pickup.id, '1111');
      const correct = await confirmPickup(sellerA, pickup.id, '0427');
      const view = await new SellerViewOrder(gate, deps).execute(sellerA, {
        sellerOrderId: pickup.id,
      });

      expect(fifth).toEqual(err({ code: 'ordering.pickup-code-locked' }));
      expect(correct).toEqual(err({ code: 'ordering.pickup-code-locked' }));
      expect(view.ok && view.value.pickup).toEqual({ attemptsLeft: 0, locked: true });
      expect(codes.rows.get(pickup.id)).toMatchObject({ failedAttempts: 5, lockedAt: T0 });

      // The buyer asks for a new code: the lock is lifted and the old code is dead.
      vault.next = ['8841'];
      const renewed = await regenerate(order.id, SELLER_A);
      expect(renewed).toEqual(
        ok({ sellerId: SELLER_A, code: '8841', attemptsLeft: 5, locked: false }),
      );
      expect(await confirmPickup(sellerA, pickup.id, '0427')).toEqual(
        err({ code: 'ordering.pickup-code-invalid', attemptsLeft: 4 }),
      );
      expect((await confirmPickup(sellerA, pickup.id, '8841')).ok).toBe(true);
    });

    it("answers another shop's order exactly as an unknown one, and counts nothing", async () => {
      const { pickup } = await readyOrder();

      const foreign = await confirmPickup(sellerB, pickup.id, '1111');
      const unknown = await confirmPickup(sellerA, id<'SellerOrder'>(0xdead), '1111');

      expect(foreign).toEqual(err({ code: 'ordering.seller-order-not-found' }));
      expect(unknown).toEqual(foreign);
      expect(codes.rows.get(pickup.id)!.failedAttempts).toBe(0);
    });

    it('refuses an order that is not ready, not a pickup, and a bad code, counting nothing', async () => {
      vault.next = ['0427'];
      const { order, pickup } = await paid();
      expect(await confirmPickup(sellerA, pickup.id, '0427')).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );

      const notPickup = order.sellerOrders.find((s) => s.sellerId === SELLER_B)!;
      await ready(sellerB, notPickup.id);
      expect(await confirmPickup(sellerB, notPickup.id, '0427')).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );

      await ready(sellerA, pickup.id);
      for (const bad of ['042', '04277', 'abcd', '', 427, null, undefined]) {
        expect(await confirmPickup(sellerA, pickup.id, bad)).toEqual(
          err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] }),
        );
      }
      expect(await confirmPickup(sellerA, 'nope', '0427')).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: 'sellerOrderId', code: 'format' }],
        }),
      );
      expect(codes.rows.get(pickup.id)!.failedAttempts).toBe(0);
    });

    it('is refused by the gate without the permission', async () => {
      const { pickup } = await readyOrder();
      allowed = false;

      const denied = await confirmPickup(sellerA, pickup.id, '0427');

      expect(denied.ok).toBe(false);
      expect(!denied.ok && denied.error.code).toBe('access.denied');
      expect(codes.rows.get(pickup.id)!.failedAttempts).toBe(0);
    });

    it('is refused for a customer session', async () => {
      const { pickup } = await readyOrder();

      const denied = await confirmPickup(customer, pickup.id, '0427');

      expect(!denied.ok && denied.error.code).toBe('access.denied');
    });
  });

  describe('regenerate', () => {
    it('gives the buyer a new code for a ready pickup part, and refuses everyone else', async () => {
      const { order, pickup } = await readyOrder();
      vault.next = ['5150'];

      const renewed = await regenerate(order.id, SELLER_A);
      const stranger = await regenerate(order.id, SELLER_A, customerOf(OTHER, 0x62));
      const seen = await viewOwn(order.id);

      expect(renewed).toEqual(
        ok({ sellerId: SELLER_A, code: '5150', attemptsLeft: 5, locked: false }),
      );
      expect(stranger).toEqual(err({ code: 'ordering.order-not-found' }));
      expect(seen.ok && seen.value.pickupCodes[0]?.code).toBe('5150');
      expect(codes.rows.get(pickup.id)!.issuedAt).toEqual(T0);
    });

    it('refuses a part that is not ready, not a pickup, or already collected', async () => {
      vault.next = ['0427'];
      const { order, pickup } = await paid();
      expect(await regenerate(order.id, SELLER_A)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      expect(await regenerate(order.id, SELLER_B)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      await ready(sellerA, pickup.id);
      await confirmPickup(sellerA, pickup.id, '0427');
      expect(await regenerate(order.id, SELLER_A)).toEqual(
        err({ code: 'ordering.fulfilment-conflict' }),
      );
      expect(await regenerate('nope', SELLER_A)).toMatchObject({ ok: false });
    });
  });
});
