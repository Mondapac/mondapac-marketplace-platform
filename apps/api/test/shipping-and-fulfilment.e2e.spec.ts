import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SellerDeliverOrder } from '../src/modules/ordering/application/use-cases/seller-deliver-order.use-case';
import { SellerListOrders } from '../src/modules/ordering/application/use-cases/seller-list-orders.use-case';
import { SellerShipOrder } from '../src/modules/ordering/application/use-cases/seller-ship-order.use-case';
import { SellerViewOrder } from '../src/modules/ordering/application/use-cases/seller-view-order.use-case';
import { ORDERING_STATUS } from '../src/modules/ordering/presentation/http-answers';
import { SetFlatFee } from '../src/modules/shipping/application/use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from '../src/modules/shipping/application/use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from '../src/modules/shipping/application/use-cases/view-own-flat-fee.use-case';
import { SHIPPING_STATUS } from '../src/modules/shipping/presentation/http-answers';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller order routes (list, one, ship, deliver) and the flat shipping fee routes (admin and
// seller) over HTTP: the real guards and controllers; the use cases are stubs, so this proves the
// session, the panel population, CSRF, the closed bodies, the status of each refusal, the answer
// shape and `no-store`. The use cases have their own specs.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const SELLER = id<'Seller'>(0xb020);
const SELLER_ORDER = id<'SellerOrder'>(0xc020);
const ORDER = id<'Order'>(0xc021);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const detail = (currency: string, patch: object = {}) => ({
  sellerOrderId: SELLER_ORDER,
  orderId: ORDER,
  paidAt: START,
  sellerId: SELLER,
  subtotal: money(3000n, currency),
  shipping: money(500n, currency),
  tax: money(273n, currency),
  total: money(3500n, currency),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  lines: [
    {
      lineId: id<'OrderLine'>(0xc030),
      offerId: id<'Offer'>(0xc001),
      variantId: id<'Variant'>(0xc002),
      quantity: 2,
      unitPrice: money(1500n, currency),
      lineAmount: money(3000n, currency),
      taxInclusive: true,
      taxRateBps: 1000,
      taxCategoryCode: 'taxable',
      tax: money(273n, currency),
    },
  ],
  ...patch,
});

it('maps every refusal code of the shipping and seller order routes to its exact status', () => {
  expect(SHIPPING_STATUS).toEqual({
    'validation.failed': 400,
    'shipping.seller-not-found': 404,
    'shipping.fee-not-set': 404,
    'shipping.unavailable': 503,
  });
  expect(ORDERING_STATUS['ordering.seller-order-not-found']).toBe(404);
  expect(ORDERING_STATUS['ordering.fulfilment-conflict']).toBe(409);
  expect(ORDERING_STATUS['ordering.shipping-unavailable']).toBe(503);
});

describe.each(TEST_MARKETS)('seller orders and flat fee over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SellerListOrders)
          .useValue(stub('list'))
          .overrideProvider(SellerViewOrder)
          .useValue(stub('view'))
          .overrideProvider(SellerShipOrder)
          .useValue(stub('ship'))
          .overrideProvider(SellerDeliverOrder)
          .useValue(stub('deliver'))
          .overrideProvider(SetFlatFee)
          .useValue(stub('set-fee'))
          .overrideProvider(ViewFlatFee)
          .useValue(stub('view-fee'))
          .overrideProvider(ViewOwnFlatFee)
          .useValue(stub('own-fee')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'ship-seed-0001'), {});
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    for (const [accountId, population, label] of [
      [OWNER, 'seller', 'owner'],
      [ADMIN, 'admin', 'admin'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  function sessionOf(population: 'seller' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'seller' ? OWNER : ADMIN,
        population,
        sellerId: population === 'seller' ? SELLER : null,
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
  const seller = () => sessionOf('seller', 1);
  const admin = () => sessionOf('admin', 2);

  const call = (
    method: 'get' | 'post' | 'put',
    population: 'seller' | 'admin',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const ORDERS = '/ordering/seller/orders';
  const FEE = `/shipping/admin/sellers/${SELLER}/flat-fee`;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(detail(currency));
  });
  afterEach(async () => {
    await app?.close();
  });

  describe('seller orders', () => {
    it('lists the paid orders newest first with no-store and serialises money and instants', async () => {
      await boot();
      next = ok({ sellerOrders: [detail(currency)], nextCursor: '1.cursor' });

      const res = await call('get', 'seller', `${ORDERS}?limit=10&cursor=abc`, seller());

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        nextCursor: '1.cursor',
        sellerOrders: [
          {
            sellerOrderId: SELLER_ORDER,
            orderId: ORDER,
            paidAt: START.toString(),
            shipping: { amount: '500', currency },
            total: { amount: '3500', currency },
            fulfilment: 'to-ship',
            carrier: null,
            shippedAt: null,
            lines: [{ quantity: 2, lineAmount: { amount: '3000', currency } }],
          },
        ],
      });
      expect(calls).toEqual([{ name: 'list', input: { cursor: 'abc', limit: 10 } }]);
    });

    it('reads one order and maps not found, a bad id and a denial', async () => {
      await boot();
      const session = seller();

      const one = await call('get', 'seller', `${ORDERS}/${SELLER_ORDER}`, session);
      expect(one.status).toBe(200);
      expect(calls[0]).toEqual({ name: 'view', input: { sellerOrderId: SELLER_ORDER } });

      next = err({ code: 'ordering.seller-order-not-found' });
      const missing = await call('get', 'seller', `${ORDERS}/${SELLER_ORDER}`, session);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ statusCode: 404, code: 'ordering.seller-order-not-found' });
      next = err({
        code: 'validation.failed',
        fields: [{ path: 'sellerOrderId', code: 'format' }],
      });
      expect((await call('get', 'seller', `${ORDERS}/nope`, session)).status).toBe(400);
      next = err({ code: 'access.denied' });
      expect((await call('get', 'seller', ORDERS, session)).status).toBe(403);
    });

    it('records the shipment from a closed JSON body and answers the new state', async () => {
      await boot();
      const session = seller();
      next = ok(
        detail(currency, {
          fulfilment: 'shipped',
          carrier: 'Australia Post',
          trackingRef: 'AP1',
          shippedAt: START,
        }),
      );

      const res = await call('post', 'seller', `${ORDERS}/${SELLER_ORDER}/ship`, session, {
        carrier: 'Australia Post',
        trackingRef: 'AP1',
      });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        fulfilment: 'shipped',
        carrier: 'Australia Post',
        trackingRef: 'AP1',
        shippedAt: START.toString(),
      });
      expect(calls).toEqual([
        {
          name: 'ship',
          input: { sellerOrderId: SELLER_ORDER, carrier: 'Australia Post', trackingRef: 'AP1' },
        },
      ]);
    });

    it('refuses a shipment without CSRF or a session, with a stray field, and not as JSON', async () => {
      await boot();
      const session = seller();
      const path = `${ORDERS}/${SELLER_ORDER}/ship`;
      const body = { carrier: 'Post' };

      expect((await call('post', 'seller', path, { cookie: session.cookie }, body)).status).toBe(
        403,
      );
      const extra = await call('post', 'seller', path, session, { carrier: 'Post', sellerId: 'x' });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      const text = await http()
        .post(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .set('content-type', 'text/plain')
        .send('x');
      expect(text.status).toBe(415);
      expect(calls).toEqual([]);
    });

    it('maps the shipment refusals: invalid fields, not found and a step already taken', async () => {
      await boot();
      const session = seller();
      const path = `${ORDERS}/${SELLER_ORDER}/ship`;

      next = err({ code: 'validation.failed', fields: [{ path: 'carrier', code: 'format' }] });
      const invalid = await call('post', 'seller', path, session, { carrier: '' });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'carrier' }] } });
      next = err({ code: 'ordering.seller-order-not-found' });
      expect((await call('post', 'seller', path, session, { carrier: 'Post' })).status).toBe(404);
      next = err({ code: 'ordering.fulfilment-conflict' });
      const conflict = await call('post', 'seller', path, session, { carrier: 'Post' });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ statusCode: 409, code: 'ordering.fulfilment-conflict' });
    });

    it('marks a shipped order delivered from an empty body only', async () => {
      await boot();
      const session = seller();
      const path = `${ORDERS}/${SELLER_ORDER}/deliver`;
      next = ok(detail(currency, { fulfilment: 'delivered', deliveredAt: START }));

      const done = await call('post', 'seller', path, session, {});
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ fulfilment: 'delivered', deliveredAt: START.toString() });
      expect(calls).toEqual([{ name: 'deliver', input: { sellerOrderId: SELLER_ORDER } }]);

      const extra = await call('post', 'seller', path, session, { carrier: 'x' });
      expect(extra.status).toBe(400);
      expect((await call('post', 'seller', path, { cookie: session.cookie }, {})).status).toBe(403);
      next = err({ code: 'ordering.fulfilment-conflict' });
      expect((await call('post', 'seller', path, session, {})).status).toBe(409);
      expect(calls).toHaveLength(2);
    });
  });

  describe('flat shipping fee', () => {
    it('lets an admin read and set a seller’s fee, passing the amount to the use case', async () => {
      await boot();
      const session = admin();
      next = ok({ sellerId: SELLER, fee: money(995n, currency) });

      const read = await call('get', 'admin', FEE, session);
      expect(read.status).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body).toEqual({ sellerId: SELLER, amount: '995', currency });

      const set = await call('put', 'admin', FEE, session, { amount: 995 });
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ sellerId: SELLER, amount: '995', currency });
      expect(calls).toEqual([
        { name: 'view-fee', input: { sellerId: SELLER } },
        { name: 'set-fee', input: { sellerId: SELLER, amount: 995 } },
      ]);
    });

    it('refuses a set without CSRF, with a stray field and not as JSON', async () => {
      await boot();
      const session = admin();

      expect(
        (await call('put', 'admin', FEE, { cookie: session.cookie }, { amount: 1 })).status,
      ).toBe(403);
      const extra = await call('put', 'admin', FEE, session, { amount: 1, currency: 'USD' });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        details: { fields: [{ path: 'currency', code: 'unknown-field' }] },
      });
      const text = await http()
        .put(FEE)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .set('content-type', 'text/plain')
        .send('x');
      expect(text.status).toBe(415);
      expect(calls).toEqual([]);
    });

    it('maps invalid, unknown seller, no fee yet, unavailable and denied', async () => {
      await boot();
      const session = admin();
      const put = () => call('put', 'admin', FEE, session, { amount: 1 });

      next = err({ code: 'validation.failed', fields: [{ path: 'amount', code: 'range' }] });
      expect((await put()).status).toBe(400);
      next = err({ code: 'shipping.seller-not-found' });
      expect((await put()).status).toBe(404);
      next = err({ code: 'shipping.unavailable' });
      expect((await put()).status).toBe(503);
      next = err({ code: 'access.denied' });
      expect((await put()).status).toBe(403);
      next = err({ code: 'shipping.fee-not-set' });
      const unset = await call('get', 'admin', FEE, session);
      expect(unset.status).toBe(404);
      expect(unset.body).toEqual({ statusCode: 404, code: 'shipping.fee-not-set' });
    });

    it('lets a seller read its own fee', async () => {
      await boot();
      next = ok({ sellerId: SELLER, fee: money(0n, currency) });

      const own = await call('get', 'seller', '/shipping/seller/flat-fee', seller());
      expect(own.status).toBe(200);
      expect(own.body).toEqual({ sellerId: SELLER, amount: '0', currency });
      expect(calls).toEqual([{ name: 'own-fee', input: {} }]);
    });
  });
});
