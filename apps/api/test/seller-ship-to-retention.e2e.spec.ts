import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ORDER_LABELS } from '../src/modules/ordering/application/ports/order-labels';
import { ORDER_REPOSITORY } from '../src/modules/ordering/application/ports/order.repository';
import {
  REFUND_REPOSITORY,
  type RefundRepository,
} from '../src/modules/ordering/application/ports/refund.repository';
import { SHIP_TO_CIPHER } from '../src/modules/ordering/application/ports/ship-to-cipher';
import type { OrderLine, OrderState, SellerOrder } from '../src/modules/ordering/domain/order';
import type { Refund } from '../src/modules/ordering/domain/refund';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  FakeLabels,
  FakeShipToCipher,
  MemoryOrders,
  NO_REFUNDS,
  TEST_DELIVERY_ADDRESS,
} from './support/ordering-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's order page over HTTP with the real guards, controller, gate and use case (orders
// in memory): the customer's address, phone and note to the seller are on the page until 30 days
// after delivery (60 days after a shipment never delivered) and null from then on, and null at
// once when every unit is refunded (owner decisions 2026-11-14 and 2026-11-15).

const DELIVERED = Temporal.Instant.from('2026-10-01T05:00:00Z');
const START = DELIVERED.subtract({ hours: 48 });
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const CUSTOMER = id<'Account'>(0xc101);
const SELLER = id<'Seller'>(0xb020);
const ORDER = id<'Order'>(0xd001);
const SELLER_ORDER = id<'SellerOrder'>(0xd00a);
const LINE = id<'OrderLine'>(0xd0a1);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('seller ship-to retention over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  let app: NestExpressApplication;
  let orders: MemoryOrders;
  let listed: Refund[] = [];
  const clock = new FixedClock(START);
  const http = () => request(app.getHttpServer());

  const sellerOrder = (patch: Partial<SellerOrder>): SellerOrder => ({
    id: SELLER_ORDER,
    sellerId: SELLER,
    subtotal: 3000n,
    shipping: 500n,
    shippingTaxRateBps: null,
    shippingTax: null,
    shippingTaxInclusive: null,
    total: 3500n,
    fulfilment: 'delivered',
    carrier: null,
    trackingRef: null,
    shippedAt: DELIVERED.subtract({ hours: 2 }),
    deliveredAt: DELIVERED,
    inventoryRecordedAt: null,
    ledgerState: 'pending',
    deliveryMethod: 'instant',
    deliveryWindow: null,
    readyAt: START.add({ minutes: 10 }),
    readyPrepMinutes: null,
    deliveryAttention: null,
    deliveryQuote: null,
    ...patch,
  });
  const orderWith = (patch: Partial<SellerOrder>): OrderState => ({
    id: ORDER,
    marketId,
    accountId: CUSTOMER,
    status: 'confirmed',
    cancelReason: null,
    paymentState: 'captured',
    total: money(3500n, currency),
    reservationId: 'r',
    stripeIdempotencyKey: 'k',
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paymentExpiresAt: START.add({ minutes: 30 }),
    createdAt: START,
    confirmedAt: START.add({ minutes: 1 }),
    cancelledAt: null,
    version: 2,
    taxStrategyId: null,
    shipToSealed: `sealed:${CUSTOMER}:${JSON.stringify({
      ...TEST_DELIVERY_ADDRESS,
      sellerNotes: { [SELLER]: 'Ring twice' },
    })}`,
    sellerOrders: [sellerOrder(patch)],
    lines: [line],
  });
  const line: OrderLine = {
    id: LINE,
    sellerOrderId: SELLER_ORDER,
    offerId: id<'Offer'>(0xc001),
    variantId: id<'Variant'>(0xc002),
    quantity: 2,
    unitPrice: money(1500n, currency),
    lineAmount: 3000n,
    taxInclusive: true,
    reservationLineId: 'rl-1',
    commissionRateBps: null,
    commissionRateReason: 'standard',
    exclusiveSeller: false,
    taxRateBps: null,
    taxAmount: null,
    taxCategoryCode: null,
  };
  const refundOf = (n: number, state: Refund['state'], quantity: number): Refund => ({
    id: id<'Refund'>(0xe700 + n),
    orderId: ORDER,
    sellerOrderId: SELLER_ORDER,
    sellerId: SELLER,
    currency,
    gross: 1500n * BigInt(quantity),
    tax: 0n,
    shipping: null,
    reason: 'damaged',
    lossBearer: 'seller',
    lossReasonCode: null,
    actor: { population: 'admin', accountId: id<'Account'>(0xa001) },
    state,
    stripeIdempotencyKey: `r-${n}`,
    stripeRefundId: null,
    attempts: 0,
    requestedAt: START,
    settledAt: null,
    lines: [
      {
        orderLineId: LINE,
        quantity,
        lineQuantity: 2,
        unitsBefore: 0,
        gross: 1500n * BigInt(quantity),
        tax: 0n,
        taxRateBps: 0,
        taxInclusive: true,
      },
    ],
  });

  beforeEach(async () => {
    fakes.reset();
    clock.set(START);
    orders = new MemoryOrders();
    orders.rows.set(ORDER, orderWith({}));
    listed = [];
    const refunds = Object.assign(Object.create(NO_REFUNDS) as RefundRepository, {
      listOfSellerOrder: () => Promise.resolve(listed),
    });
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(ORDER_REPOSITORY)
          .useValue(orders)
          .overrideProvider(REFUND_REPOSITORY)
          .useValue(refunds)
          .overrideProvider(ORDER_LABELS)
          .useValue(new FakeLabels())
          .overrideProvider(SHIP_TO_CIPHER)
          .useValue(new FakeShipToCipher()),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'keep-seed-0001'), {});
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
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe101),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf101),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  });
  afterEach(async () => {
    await app?.close();
  });

  let sessionCount = 0;
  function headers() {
    const issued = tokens.issue();
    sessionCount += 1;
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf800 + sessionCount),
        marketId,
        accountId: OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'seller'),
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const page = () => http().get(`/ordering/seller/orders/${SELLER_ORDER}`).set(headers());

  it('shows the address and note to ship after 90 days, and 50 days into an undelivered shipment', async () => {
    clock.set(DELIVERED.add({ hours: 24 * 90 }));
    orders.rows.set(
      ORDER,
      orderWith({ fulfilment: 'to-ship', shippedAt: null, deliveredAt: null }),
    );
    const toShip = await page();
    expect(toShip.status).toBe(200);
    expect(toShip.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS, buyerNote: 'Ring twice' });

    orders.rows.set(ORDER, orderWith({ fulfilment: 'shipped', deliveredAt: null }));
    clock.set(DELIVERED.add({ hours: 24 * 50 }));
    const shipped = await page();
    expect(shipped.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS, buyerNote: 'Ring twice' });
  });

  it('withholds a shipped, never delivered order 60 days after shipping', async () => {
    const shippedAt = DELIVERED.subtract({ hours: 2 });
    orders.rows.set(ORDER, orderWith({ fulfilment: 'shipped', shippedAt, deliveredAt: null }));
    clock.set(shippedAt.add({ hours: 60 * 24 - 1 }));
    const before = await page();
    expect(before.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS, buyerNote: 'Ring twice' });

    clock.set(shippedAt.add({ hours: 60 * 24 }));
    const after = await page();
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ fulfilment: 'shipped', shipTo: null, buyerNote: null });
  });

  it('withholds the address at once when every unit is refunded, not for a partial refund', async () => {
    orders.rows.set(
      ORDER,
      orderWith({ fulfilment: 'to-ship', shippedAt: null, deliveredAt: null }),
    );
    listed = [refundOf(1, 'succeeded', 1)];
    const partial = await page();
    expect(partial.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS, buyerNote: 'Ring twice' });

    listed = [refundOf(1, 'succeeded', 1), refundOf(2, 'pending', 1)];
    const full = await page();
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ fulfilment: 'to-ship', shipTo: null, buyerNote: null });
    expect((full.body as { refunds: unknown[] }).refunds).toHaveLength(2);
    expect(JSON.stringify(full.body)).not.toContain(TEST_DELIVERY_ADDRESS.phone);
  });

  it('shows them 29 days 23 hours after delivery and answers null from 30 days on', async () => {
    clock.set(DELIVERED.add({ hours: 30 * 24 - 1 }));
    const before = await page();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ shipTo: TEST_DELIVERY_ADDRESS, buyerNote: 'Ring twice' });

    clock.set(DELIVERED.add({ hours: 30 * 24 }));
    const after = await page();
    expect(after.status).toBe(200);
    expect(after.headers['cache-control']).toBe('no-store');
    expect(after.body).toMatchObject({
      sellerOrderId: SELLER_ORDER,
      fulfilment: 'delivered',
      deliveredAt: DELIVERED.toString(),
      shipTo: null,
      buyerNote: null,
    });
    expect(JSON.stringify(after.body)).not.toContain(TEST_DELIVERY_ADDRESS.phone);
    expect(JSON.stringify(after.body)).not.toContain('Ring twice');
  });
});
