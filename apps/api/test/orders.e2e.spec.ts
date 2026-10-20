import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CART_CHECKOUT_FACADE } from '../src/modules/cart';
import { CUSTOMERS_CHECKOUT_FACADE } from '../src/modules/customers';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { INVENTORY_ORDERING_PORT } from '../src/modules/inventory/contracts/ordering-port';
import { CHECKOUT_GATEWAY } from '../src/modules/ordering/application/ports/checkout-gateway';
import { ORDER_REPOSITORY } from '../src/modules/ordering/application/ports/order.repository';
import { SHIP_TO_CIPHER } from '../src/modules/ordering/application/ports/ship-to-cipher';
import { ORDERING_STATUS } from '../src/modules/ordering/presentation/http-answers';
import { COMMISSION_PAYOUTS_FACADE } from '../src/modules/commission-payouts';
import { SHIPPING_FACADE } from '../src/modules/shipping';
import { ORDER_TAX_CATEGORIES } from '../src/modules/ordering/application/ports/order-tax-categories';
import { TAX_FACADE } from '../src/modules/tax';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  FakeCart,
  FakeCustomers,
  FakeGateway,
  FakeInventory,
  FakeCommission,
  FakeTax,
  FakeTaxCategories,
  FakeShipping,
  FakeShipToCipher,
  MemoryOrders,
  TEST_DELIVERY_ADDRESS,
} from './support/ordering-fakes';
import { FakeUnitOfWork, RecordingAuditWriter, RecordingOutbox } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The checkout and order routes over HTTP: the real guards, controllers, gate and use cases; the
// order store, Stripe, inventory and the cart are in memory. Proves the session and CSRF rules,
// the closed body, no-store, the status of each refusal, Retry-After, that a customer never sees
// another's order, and the admin reads behind `ordering.order.view`.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xa101);
const OTHER_CUSTOMER = id<'Account'>(0xa102);
const VIEWER = id<'Account'>(0xa001);
const NO_KEY = id<'Account'>(0xa003);
const REFUNDER = id<'Account'>(0xa009);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);
const SELLER = id<'Seller'>(0xb020);
const OFFER = id<'Offer'>(0xc001);
const VARIANT = id<'Variant'>(0xc002);
const ADDRESS = id<'CustomerAddress'>(0xad01);

interface Body {
  code: string;
  orderId: string;
  orders: unknown[];
}
const body = (res: request.Response) => res.body as Body;

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the ordering use cases to its exact status', () => {
  expect(ORDERING_STATUS).toEqual({
    'validation.failed': 400,
    'ordering.order-not-found': 404,
    'ordering.address-not-found': 422,
    'ordering.outside-delivery-area': 422,
    'ordering.cart-empty': 422,
    'ordering.cart-not-purchasable': 422,
    'ordering.stock-insufficient': 409,
    'ordering.cart-not-ready': 409,
    'conflict.retry': 409,
    'request.throttled': 429,
    'ordering.check-unavailable': 503,
    'ordering.shipping-unavailable': 503,
    'ordering.seller-order-not-found': 404,
    'ordering.fulfilment-conflict': 409,
    'ordering.payment-unavailable': 503,
    'ordering.refund-disabled': 409,
    'ordering.refund-not-allowed': 409,
    'ordering.refund-in-progress': 409,
    'ordering.refund-tax-unknown': 422,
    'ordering.refund-exceeds': 422,
    'ordering.refund-rejected': 422,
    'ordering.refund-tax-unavailable': 503,
    'ordering.document-not-available': 409,
    'ordering.invoice-numbering-unavailable': 503,
    'access.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('ordering routes over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let app: NestExpressApplication;
  let orders: MemoryOrders;
  let gateway: FakeGateway;
  let inventory: FakeInventory;
  let cart: FakeCart;
  let shipping: FakeShipping;
  const clock = new FixedClock(START);
  const http = () => request(app.getHttpServer());
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);

  beforeEach(async () => {
    fakes.reset();
    orders = new MemoryOrders();
    gateway = new FakeGateway();
    inventory = new FakeInventory();
    cart = new FakeCart();
    shipping = new FakeShipping();
    const customers = new FakeCustomers();
    customers.addresses.set(ADDRESS, { accountId: CUSTOMER, address: TEST_DELIVERY_ADDRESS });
    // The seller delivers for a flat 5.00.
    shipping.fees.set(SELLER, money(500n, currency));
    cart.lines = [
      {
        offerId: OFFER,
        variantId: VARIANT,
        quantity: 2,
        state: 'buyable',
        sellerId: SELLER,
        unitPrice: money(1500n, currency),
        taxInclusive: true,
      },
    ];
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(AUDIT_WRITER)
          .useValue(new RecordingAuditWriter())
          .overrideProvider(OUTBOX_WRITER)
          .useValue(new RecordingOutbox())
          .overrideProvider(ORDER_REPOSITORY)
          .useValue(orders)
          .overrideProvider(CHECKOUT_GATEWAY)
          .useValue(gateway)
          .overrideProvider(INVENTORY_ORDERING_PORT)
          .useValue(inventory)
          .overrideProvider(CART_CHECKOUT_FACADE)
          .useValue(cart)
          .overrideProvider(CUSTOMERS_CHECKOUT_FACADE)
          .useValue(customers)
          .overrideProvider(SHIP_TO_CIPHER)
          .useValue(new FakeShipToCipher())
          .overrideProvider(SHIPPING_FACADE)
          .useValue(shipping)
          .overrideProvider(TAX_FACADE)
          .useValue(new FakeTax())
          .overrideProvider(ORDER_TAX_CATEGORIES)
          .useValue(new FakeTaxCategories(code === 'AU' ? 'taxable' : 'zz_standard'))
          .overrideProvider(COMMISSION_PAYOUTS_FACADE)
          .useValue(new FakeCommission()),
    }));
  });
  afterEach(async () => {
    await app?.close();
  });

  const seedAccount = (accountId: Id<'Account'>, population: 'customer' | 'admin', label: string) =>
    fakes.seedAccount({
      id: accountId,
      marketId: code as AccountState['marketId'],
      population,
      email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
      displayName: population === 'admin' ? `Name ${label}` : null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });

  function session(accountId: Id<'Account'>, population: 'customer' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId,
        population,
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const customer = (accountId: Id<'Account'> = CUSTOMER, n = 1) => {
    seedAccount(accountId, 'customer', `c${n}`);
    return session(accountId, 'customer', n);
  };
  const checkout = (headers: Record<string, string>, body: unknown = { addressId: ADDRESS }) =>
    http()
      .post('/orders/checkout')
      .set({ 'x-market-id': code, ...headers })
      .send(body as object);

  describe('checkout', () => {
    it('opens the payment page for a signed-in customer and answers no-store', async () => {
      const res = await checkout(customer());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        checkoutUrl: 'https://checkout.stripe.test/c/cs_test_1',
        total: { amount: '3500', currency },
      });
      expect([...orders.rows.values()][0]).toMatchObject({
        accountId: CUSTOMER,
        status: 'pending-payment',
      });
    });

    it('needs a session and the CSRF token', async () => {
      const { cookie } = customer();

      expect((await checkout({})).status).toBe(401);
      expect((await checkout({ cookie })).status).toBe(403);
      expect(orders.rows.size).toBe(0);
    });

    it('takes JSON with the address id only', async () => {
      const headers = customer();

      const form = await http()
        .post('/orders/checkout')
        .set({ 'x-market-id': code, ...headers, 'content-type': 'text/plain' })
        .send('x');
      const extra = await checkout(headers, { accountId: 'x' });

      expect(form.status).toBe(415);
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
      });
      expect(inventory.calls).toEqual([]);
    });

    it("refuses a missing address and one that is not the customer's own", async () => {
      const headers = customer();

      const missing = await checkout(headers, {});
      const foreign = await checkout(headers, { addressId: id<'CustomerAddress'>(0xad02) });

      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'addressId', code: 'required' }] },
      });
      expect(foreign.status).toBe(422);
      expect(foreign.body).toEqual({ statusCode: 422, code: 'ordering.address-not-found' });
      expect(inventory.calls).toEqual([]);
      expect(orders.rows.size).toBe(0);
    });

    it('refuses an address the Market does not deliver to, before anything is reserved', async () => {
      const headers = customer();
      shipping.outside.add(TEST_DELIVERY_ADDRESS.postcode);

      const outside = await checkout(headers);

      expect(outside.status).toBe(422);
      expect(outside.body).toEqual({ statusCode: 422, code: 'ordering.outside-delivery-area' });
      expect(inventory.calls).toEqual([]);
      expect(orders.rows.size).toBe(0);
    });

    it("keeps the customer's note to each seller with the order, and refuses a bad note", async () => {
      const headers = customer();
      const gone = id<'Seller'>(0xb0ff);

      const started = await checkout(headers, {
        addressId: ADDRESS,
        sellerNotes: { [SELLER]: '  Ring twice\r\nThanks 👩\u200d🍳  ', [gone]: 'Not in the cart' },
      });
      const one = await http()
        .get(`/orders/${body(started).orderId}`)
        .set({ 'x-market-id': code, cookie: headers.cookie });
      const long = await checkout(headers, {
        addressId: ADDRESS,
        sellerNotes: { [SELLER]: 'x'.repeat(201) },
      });
      const control = await checkout(headers, {
        addressId: ADDRESS,
        sellerNotes: { [SELLER]: 'bell\u0007' },
      });
      const hidden = await Promise.all(
        ['\u202edesrever', 'zero\u200bwidth', 'line\u2028sep'].map((note) =>
          checkout(headers, { addressId: ADDRESS, sellerNotes: { [SELLER]: note } }),
        ),
      );
      const notAnId = await checkout(headers, { addressId: ADDRESS, sellerNotes: { x: 'y' } });

      expect(started.status).toBe(200);
      // Trimmed, and the note to a seller that is not in the cart any more is dropped.
      expect(one.body).toMatchObject({
        sellerNotes: { [SELLER]: 'Ring twice\nThanks 👩\u200d🍳' },
      });
      expect(Object.keys((one.body as { sellerNotes: object }).sellerNotes)).toEqual([SELLER]);
      expect(long.status).toBe(400);
      expect(long.body).toMatchObject({
        details: { fields: [{ path: `sellerNotes.${SELLER}`, code: 'length' }] },
      });
      expect(control.body).toMatchObject({
        details: { fields: [{ path: `sellerNotes.${SELLER}`, code: 'format' }] },
      });
      // A bidi override, a zero-width space and a line separator would hide what the note says.
      for (const res of hidden) {
        expect(res.body).toMatchObject({
          details: { fields: [{ path: `sellerNotes.${SELLER}`, code: 'format' }] },
        });
      }
      expect(notAnId.body).toMatchObject({
        details: { fields: [{ path: 'sellerNotes', code: 'format' }] },
      });
      expect(orders.rows.size).toBe(1);
    });

    it('answers the refusals with their status and details', async () => {
      const headers = customer();

      cart.lines = [];
      const empty = await checkout(headers);
      cart.lines = [{ ...cart.lines[0]!, state: 'unavailable' } as never];
      cart.lines = [
        {
          offerId: OFFER,
          variantId: VARIANT,
          quantity: 1,
          state: 'unavailable',
          sellerId: SELLER,
          unitPrice: null,
          taxInclusive: null,
        },
      ];
      const unbuyable = await checkout(headers);
      cart.down = true;
      const down = await checkout(headers);
      cart.down = false;
      cart.lines = [
        {
          offerId: OFFER,
          variantId: VARIANT,
          quantity: 1,
          state: 'buyable',
          sellerId: SELLER,
          unitPrice: money(100n, currency),
          taxInclusive: true,
        },
      ];
      inventory.reserveFails = {
        code: 'inventory.insufficient',
        details: { lines: [{ offerId: OFFER, variantId: VARIANT, reason: 'not-enough' }] },
      };
      const stock = await checkout(headers);
      inventory.reserveFails = { code: 'request.throttled', retryAfterSeconds: 90 };
      const throttled = await checkout(headers);
      inventory.reserveFails = null;
      gateway.createFails = { code: 'payment.provider-unavailable' };
      const payment = await checkout(headers);

      gateway.createFails = null;
      shipping.fees.clear();
      const noFee = await checkout(headers);

      expect(
        [empty, unbuyable, down, stock, throttled, payment, noFee].map((r) => r.status),
      ).toEqual([422, 422, 503, 409, 429, 503, 503]);
      // The customer learns that delivery is unavailable, never which seller lacks a fee.
      expect(noFee.body).toEqual({ statusCode: 503, code: 'ordering.shipping-unavailable' });
      expect(body(empty).code).toBe('ordering.cart-empty');
      // A cart that is not ready (a seller below its minimum order) is a 409 with the sellers.
      cart.notReady = {
        code: 'cart.not-ready',
        details: {
          sellers: [
            { sellerId: SELLER, reason: 'below-minimum', minimum: money(4000n, currency) },
            { sellerId: id<'Seller'>(0xb021), reason: 'check-unavailable', minimum: null },
          ],
        },
      };
      const notReady = await checkout(headers);
      cart.notReady = null;
      expect(notReady.status).toBe(409);
      expect(notReady.body).toEqual({
        statusCode: 409,
        code: 'ordering.cart-not-ready',
        details: {
          sellers: [
            { sellerId: SELLER, reason: 'below-minimum', minimum: { amount: '4000', currency } },
            { sellerId: id<'Seller'>(0xb021), reason: 'check-unavailable', minimum: null },
          ],
        },
      });
      expect(unbuyable.body).toMatchObject({
        code: 'ordering.cart-not-purchasable',
        details: { lineIndexes: [0] },
      });
      expect(stock.body).toMatchObject({
        code: 'ordering.stock-insufficient',
        details: { lines: [{ reason: 'not-enough' }] },
      });
      expect(throttled.headers['retry-after']).toBe('90');
      expect(body(payment).code).toBe('ordering.payment-unavailable');
      expect(JSON.stringify([stock.body, payment.body])).not.toMatch(/sk_|cs_test|stripe/i);
    });
  });

  describe('order reads', () => {
    it("shows a customer their own orders and answers another's order as unknown", async () => {
      const mine = customer();
      const theirs = customer(OTHER_CUSTOMER, 2);
      const started = await checkout(mine);
      const orderId = body(started).orderId;

      const list = await http().get('/orders').set({ 'x-market-id': code, cookie: mine.cookie });
      const one = await http()
        .get(`/orders/${orderId}`)
        .set({ 'x-market-id': code, cookie: mine.cookie });
      const foreign = await http()
        .get(`/orders/${orderId}`)
        .set({ 'x-market-id': code, cookie: theirs.cookie });
      const unknown = await http()
        .get(`/orders/${id<'Order'>(0xbeef)}`)
        .set({ 'x-market-id': code, cookie: theirs.cookie });
      const theirList = await http()
        .get('/orders')
        .set({ 'x-market-id': code, cookie: theirs.cookie });
      const bad = await http()
        .get('/orders?limit=0')
        .set({ 'x-market-id': code, cookie: mine.cookie });

      expect(body(list).orders).toHaveLength(1);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        orderId,
        status: 'pending-payment',
        paymentState: 'none',
        sellerOrders: [
          {
            sellerId: SELLER,
            shipping: { amount: '500', currency },
            total: { amount: '3500', currency },
            fulfilment: 'to-ship',
          },
        ],
      });
      // The address chosen at checkout, as copied onto the order.
      expect(one.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS });
      expect(body(list).orders[0]).not.toHaveProperty('shipTo');
      // Nothing of Stripe reaches the customer.
      expect(JSON.stringify(one.body)).not.toMatch(/cs_test|pi_test|idempotency|checkout-/);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(unknown.body);
      expect(body(theirList).orders).toEqual([]);
      expect(bad.status).toBe(400);
    });

    it('gives a customer the document of their own paid order only, with no address', async () => {
      const mine = customer();
      const theirs = customer(OTHER_CUSTOMER, 2);
      const orderId = body(await checkout(mine)).orderId;
      const get = (headers: Record<string, string>) =>
        http()
          .get(`/orders/${orderId}/document`)
          .set({ 'x-market-id': code, cookie: headers.cookie! });

      const unpaid = await get(mine);
      const stored = orders.rows.get(orderId)!;
      orders.rows.set(orderId, { ...stored, status: 'confirmed', confirmedAt: START });
      const paid = await get(mine);
      const foreign = await get(theirs);

      expect(unpaid.status).toBe(409);
      expect(unpaid.body).toEqual({ statusCode: 409, code: 'ordering.document-not-available' });
      expect(paid.status).toBe(200);
      expect(paid.headers['cache-control']).toBe('no-store');
      expect(paid.body).toMatchObject({
        kind: 'order-confirmation',
        documentNumber: null,
        orderId,
        sellerOrderId: null,
        paidAt: START.toString(),
        total: { amount: '3500', currency },
        parts: [
          {
            sellerId: SELLER,
            shipping: { amount: '500', currency },
            lines: [{ quantity: 2, unitPrice: { amount: '1500', currency } }],
          },
        ],
      });
      expect(JSON.stringify(paid.body)).not.toMatch(/Rahman|Example Street|pi_test|cs_test/);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: 'ordering.order-not-found' });
    });

    it('needs a session', async () => {
      expect((await http().get('/orders').set({ 'x-market-id': code })).status).toBe(401);
      const document = await http()
        .get(`/orders/${id<'Order'>(0xbeef)}/document`)
        .set({ 'x-market-id': code });
      expect(document.status).toBe(401);
    });
  });

  describe('admin reads', () => {
    const adminHeaders = (accountId: Id<'Account'>, n: number) => ({
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: session(accountId, 'admin', n).cookie,
    });

    async function seedAdmins() {
      await app
        .get(SeedRoles)
        .execute(testCallContext(marketOf(), 'system', 'order-seed-0001'), {});
      const viewerRole = [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'viewer',
      )!.id;
      fakes.seedRole({
        id: NO_KEY_ROLE,
        marketId: code as AccountState['marketId'],
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'No order key',
        permissionKeys: ['identity.admin-account.view'],
        version: 1,
        createdAt: START,
      });
      [
        [VIEWER, viewerRole, 1],
        [NO_KEY, NO_KEY_ROLE, 2],
      ].forEach(([accountId, roleId, n]) => {
        seedAccount(accountId as Id<'Account'>, 'admin', `admin${n as number}`);
        fakes.seedAssignment({
          id: id<'RoleAssignment'>(0xe000 + (n as number)),
          marketId: code as AccountState['marketId'],
          accountId: accountId as Id<'Account'>,
          roleId: roleId as Id<'Role'>,
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
      });
    }

    it('lets a role with ordering.order.view list and read orders, and no other', async () => {
      await seedAdmins();
      const started = await checkout(customer());
      const orderId = body(started).orderId;

      const list = await http()
        .get('/ordering/admin/orders?status=pending-payment')
        .set(adminHeaders(VIEWER, 11));
      const one = await http()
        .get(`/ordering/admin/orders/${orderId}`)
        .set(adminHeaders(VIEWER, 12));
      const noKey = await http().get('/ordering/admin/orders').set(adminHeaders(NO_KEY, 13));
      const customerTries = await http()
        .get('/ordering/admin/orders')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), cookie: customer().cookie });
      const unknown = await http()
        .get(`/ordering/admin/orders/${id<'Order'>(0xbeef)}`)
        .set(adminHeaders(VIEWER, 14));
      const badFilter = await http()
        .get('/ordering/admin/orders?status=shipped')
        .set(adminHeaders(VIEWER, 15));

      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(body(list).orders).toHaveLength(1);
      expect(one.body).toMatchObject({ orderId, accountId: CUSTOMER, paymentIntentId: null });
      // The tax frozen at checkout, as minor-unit strings (goods 273 plus the 500 delivery fee's
      // 45, both inclusive), and the strategy (the built-in one).
      expect(one.body).toMatchObject({
        tax: { amount: '318', currency },
        taxStrategyId: null,
        sellerOrders: [
          {
            shippingTax: { amount: '45', currency },
            tax: { amount: '318', currency },
            lines: [{ taxRateBps: 1000 }],
          },
        ],
      });
      expect(noKey.status).toBe(403);
      expect(customerTries.status).toBeGreaterThanOrEqual(401);
      expect(customerTries.status).toBeLessThanOrEqual(403);
      expect(unknown.status).toBe(404);
      expect(badFilter.status).toBe(400);
    });

    it('gives a role with ordering.order.view the document of a paid order, and no other role', async () => {
      await seedAdmins();
      const orderId = body(await checkout(customer())).orderId;
      const route = `/ordering/admin/orders/${orderId}/document`;
      const unpaid = await http().get(route).set(adminHeaders(VIEWER, 31));
      const stored = orders.rows.get(orderId)!;
      orders.rows.set(orderId, { ...stored, status: 'confirmed', confirmedAt: START });
      const paid = await http().get(route).set(adminHeaders(VIEWER, 32));
      const noKey = await http().get(route).set(adminHeaders(NO_KEY, 33));

      expect(unpaid.status).toBe(409);
      expect(paid.status).toBe(200);
      expect(paid.headers['cache-control']).toBe('no-store');
      expect(paid.body).toMatchObject({
        kind: 'order-confirmation',
        documentNumber: null,
        orderId,
        tax: { amount: '318', currency },
      });
      expect(JSON.stringify(paid.body)).not.toMatch(/Rahman|Example Street/);
      expect(noKey.status).toBe(403);
    });

    it('refunds only for an admin with ordering.order.refund, and not while the Market switch is off', async () => {
      await seedAdmins();
      const rootRole = [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.seedCode === 'platform-administrator',
      )!.id;
      seedAccount(REFUNDER, 'admin', 'admin9');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe009),
        marketId: code as AccountState['marketId'],
        accountId: REFUNDER,
        roleId: rootRole,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      const orderId = id<'Order'>(0xbe01);
      const route = `/ordering/admin/orders/${orderId}/seller-orders/${id<'SellerOrder'>(0xbe02)}/refunds`;
      const refundBody = {
        lines: [{ orderLineId: id<'OrderLine'>(0xbe03), quantity: 1 }],
        reason: 'damaged',
      };

      // A write: the session's CSRF token too.
      const writer = (accountId: Id<'Account'>, n: number) => ({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session(accountId, 'admin', n),
      });
      const off = await http().post(route).set(writer(REFUNDER, 21)).send(refundBody);
      const noKey = await http().post(route).set(writer(VIEWER, 22)).send(refundBody);
      const noCsrf = await http().post(route).set(adminHeaders(REFUNDER, 24)).send(refundBody);
      const unknownField = await http()
        .post(route)
        .set(writer(REFUNDER, 23))
        .send({ ...refundBody, amount: '1' });

      // The fixtures keep tax.refundCredit.enabled off: nothing is read or sent to Stripe.
      expect(off.status).toBe(409);
      expect(off.body).toEqual({ statusCode: 409, code: 'ordering.refund-disabled' });
      expect(off.headers['cache-control']).toBe('no-store');
      expect(gateway.refunds).toHaveLength(0);
      expect(noKey.status).toBe(403);
      expect(noCsrf.body).toMatchObject({ code: 'request.csrf' });
      expect(unknownField.status).toBe(400);
    });
  });
});
